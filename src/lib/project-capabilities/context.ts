import { graphResourceJobs } from '../task-graph/graph-association';
import type { Prisma } from '@prisma/client';
import type { ProjectCapabilityPolicy } from './policy';
import { prisma } from '../prisma';
import { resolveProjectScope } from './scope-resolution';
import { executionProgress } from '../task-graph/execution-progress';
import { graphGit } from '../task-graph/git-command';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { object, projectCapabilityPolicy, authorizeProjectCapabilities } from './policy';

export async function projectCapabilityContext({ taskId, workspace, taskRunId, policyFile, roomMessageId, executionId }: { taskId: string; workspace: string; taskRunId?: string; policyFile?: string; roomMessageId?: string; executionId?: string }, ledger?: { db: Prisma.TransactionClient; registeredPolicy: ProjectCapabilityPolicy | null }) {
  if (ledger && !executionId) throw new Error('Ledger-only authorization requires an exact execution identity');
  const db = ledger?.db || prisma;
  let jobs = await graphResourceJobs(taskId, db);
  // Automatic preflight runs before its review TaskRun exists. Its caller has
  // already checked the execution claim; keep that exact execution binding.
  if (!jobs.length && !taskRunId && executionId) {
    const job = await db.taskGraphExecution.findUnique({ where: { id: executionId }, include: { node: { include: { run: { include: { parentTask: true } } } } } });
    if (job && [`task-graph-review-${job.nodeId}`, `task-graph-architecture-${job.nodeId}`].includes(taskId)) jobs = [job];
  }
  if (!jobs.length) return null;
  if (executionId && !jobs.some(job => job.id === executionId)) throw new Error('执行不属于当前任务图');
  let repository: string;
  if (executionId) repository = jobs.find(job => job.id === executionId)!.repository;
  else if (jobs.length === 1) repository = jobs[0].repository;
  else {
    const common = await graphGit(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => '');
    if (!common) throw new Error('多仓任务必须分别解析已绑定的项目能力，不能猜测非 Git 目录身份');
    repository = await fs.realpath(path.dirname(common));
    if (jobs.length && !jobs.some(job => job.repository === repository)) return null;
  }
  let policy = ledger ? ledger.registeredPolicy : await projectCapabilityPolicy(repository, policyFile);
  const registeredPolicy = policy;
  const matches = jobs.filter(item => item.repository === repository && (!executionId || item.id === executionId));
  if (matches.length !== 1) throw new Error('同仓多个执行必须按执行身份解析授权');
  const job = matches[0];
  if (!policy) {
    const snapshot = object(job.node.run.snapshot);
    const node = Array.isArray(snapshot.nodes) ? snapshot.nodes.map(object).find(node => node.key === job.node.key) : undefined;
    const approved = node && Array.isArray(node.executions) ? node.executions.map(object).find(execution => execution.key === job.key) : undefined;
    const migrated = await db.taskGraphEvent.findFirst({ where: { runId: job.node.runId, kind: 'project_capability_scope_approved', payload: { path: ['executionId'], equals: job.id } } });
    if (approved?.capabilities || migrated) throw new Error('项目能力授权已撤销，不能回退到旧宿主授权');
    return null;
  }
  let approval: Awaited<ReturnType<typeof resolveProjectScope>>['approval'] = null;
  const principals: string[] = [];
  if (job) {
    const snapshot = object(job.node.run.snapshot);
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.map(object) : [];
    const node = nodes.find(node => node.key === job.node.key);
    const approved = node && Array.isArray(node.executions) ? node.executions.map(object).find(execution => execution.key === job.key && execution.repository === repository) : undefined;
    const resolved = await resolveProjectScope({ runId: job.node.runId, executionId: job.id, repository,
      snapshotHash: job.node.run.snapshotHash, originalScope: approved?.capabilities, policy }, db);
    policy = resolved.policy;
    approval = resolved.approval;
    const proposal = await db.taskGraphProposal.findUnique({ where: { parentTaskId_version: { parentTaskId: job.node.run.parentTaskId, version: job.node.run.version } } });
    if (proposal?.status === 'confirmed' && proposal.decidedBy) principals.push(`feishu:${policy.appId}:${proposal.decidedBy}`);
    else if (job.node.run.parentTask.ownerUserId) principals.push(`platform:${job.node.run.parentTask.ownerUserId}`);
    const actorRuns = Array.from(new Set([taskRunId, job.taskRunId, executionProgress(job.dispatchMetadata)?.taskRunId].filter((id): id is string => Boolean(id))));
    const receipts = actorRuns.length ? await db.taskGraphEvent.findMany({ where: { runId: job.node.runId, kind: { in: ['conversation_input_bound', 'conversation_steering_started'] }, OR: actorRuns.map(id => ({ payload: { path: ['taskRunId'], equals: id } })) } }) : [];
    const ids = receipts.flatMap(receipt => { const row = object(receipt.payload); return typeof row.inputId === 'string' ? [row.inputId] : []; });
    for (const input of await db.taskGraphEvent.findMany({ where: { id: { in: ids } } })) {
      const row = object(input.payload);
      if (typeof row.actorId !== 'string' || !['feishu', 'platform'].includes(String(row.actorOrigin))) throw new Error('无法确认资料请求者身份');
      principals.push(row.actorOrigin === 'feishu' ? `feishu:${policy.appId}:${row.actorId}` : `platform:${row.actorId}`);
    }
  }
  if (taskRunId) {
    const run = await db.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
    if (run.taskId !== taskId) throw new Error('Project capability TaskRun belongs to another task');
    const association = object(object(JSON.parse(run.controlMetadata || '{}')).graphAssociation || {});
    if (typeof association.roomMessageId === 'string') roomMessageId = association.roomMessageId;
  }
  if (roomMessageId) {
    const message = await db.liveRoomMessage.findUniqueOrThrow({ where: { id: roomMessageId }, include: { room: true } });
    if (!jobs.some(job => job.childTaskId === message.room.sourceTaskId) || message.messageType !== 'user') throw new Error('消息不属于当前任务');
    const metadata = object(JSON.parse(message.metadata || '{}'));
    if (metadata.source === 'feishu' && typeof metadata.feishuSenderOpenId === 'string') principals.push(`feishu:${policy.appId}:${metadata.feishuSenderOpenId}`);
    else if (!metadata.source && message.room.ownerUserId) principals.push(`platform:${message.room.ownerUserId}`);
    else throw new Error('无法确认话题资料请求者身份');
  }
  authorizeProjectCapabilities(policy, principals);
  return { policy, registeredPolicy, approval, principal: principals[0], principals: Array.from(new Set(principals)), job: job || null };
}
