import { prisma } from '../prisma';
import { graphGit } from '../task-graph/git-command';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { object, projectCapabilityPolicy, authorizeProjectCapabilities, restrictProjectCapabilities } from './policy';

export async function projectCapabilityContext(taskId: string, workspace: string, taskRunId?: string, file?: string, roomMessageId?: string) {
  const nodeId = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  const jobs = await prisma.taskGraphExecution.findMany({ where: nodeId ? { nodeId } : { childTaskId: taskId }, include: { node: { include: { run: { include: { parentTask: true } } } } } });
  if (!jobs.length) return null;
  let repository: string;
  if (jobs.length === 1) repository = jobs[0].repository;
  else {
    const common = await graphGit(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => '');
    if (!common) return null;
    repository = await fs.realpath(path.dirname(common));
    if (jobs.length && !jobs.some(job => job.repository === repository)) return null;
  }
  let policy = await projectCapabilityPolicy(repository, file);
  if (!policy) return null;
  const job = jobs.find(item => item.repository === repository);
  const principals: string[] = [];
  if (job) {
    const snapshot = object(job.node.run.snapshot);
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.map(object) : [];
    const node = nodes.find(node => node.key === job.node.key);
    const approved = node && Array.isArray(node.executions) ? node.executions.map(object).find(execution => execution.key === job.key && execution.repository === repository) : undefined;
    if (!approved?.capabilities) throw new Error('现有任务尚无获批项目能力范围；不能隐式扩大旧路线授权');
    policy = restrictProjectCapabilities(policy, approved.capabilities);
    const proposal = await prisma.taskGraphProposal.findUnique({ where: { parentTaskId_version: { parentTaskId: job.node.run.parentTaskId, version: job.node.run.version } } });
    if (proposal?.status === 'confirmed' && proposal.decidedBy) principals.push(`feishu:${policy.appId}:${proposal.decidedBy}`);
    else if (job.node.run.parentTask.ownerUserId) principals.push(`platform:${job.node.run.parentTask.ownerUserId}`);
    const receipts = taskRunId ? await prisma.taskGraphEvent.findMany({ where: { runId: job.node.runId, kind: { in: ['conversation_input_bound', 'conversation_steering_started'] }, payload: { path: ['taskRunId'], equals: taskRunId } } }) : [];
    const ids = receipts.flatMap(receipt => { const row = object(receipt.payload); return typeof row.inputId === 'string' ? [row.inputId] : []; });
    for (const input of await prisma.taskGraphEvent.findMany({ where: { id: { in: ids } } })) {
      const row = object(input.payload);
      if (typeof row.actorId !== 'string' || !['feishu', 'platform'].includes(String(row.actorOrigin))) throw new Error('无法确认资料请求者身份');
      principals.push(row.actorOrigin === 'feishu' ? `feishu:${policy.appId}:${row.actorId}` : `platform:${row.actorId}`);
    }
  }
  if (roomMessageId) {
    const message = await prisma.liveRoomMessage.findUniqueOrThrow({ where: { id: roomMessageId }, include: { room: true } });
    if (message.room.sourceTaskId !== taskId || message.messageType !== 'user') throw new Error('消息不属于当前任务');
    const metadata = object(JSON.parse(message.metadata || '{}'));
    if (metadata.source !== 'feishu' || typeof metadata.feishuSenderOpenId !== 'string') throw new Error('无法确认话题资料请求者身份');
    principals.push(`feishu:${policy.appId}:${metadata.feishuSenderOpenId}`);
  }
  authorizeProjectCapabilities(policy, principals);
  return { policy, principal: principals[0], principals: Array.from(new Set(principals)), job: job || null };
}
