import type { Prisma } from '@prisma/client';
import type { AcpxParticipantRequest } from '../acpx/types';
import { executeAcpxTaskRun } from '../acpx/runner';
import { prisma } from '../prisma';
import { effectiveArchitectureReview, type GraphDefinition } from './domain';
import type { VerificationEvidence } from './store';
import { assertReviewWorkspacesClean, type ReviewWorkspace } from './review-workspaces';
import { architectureReviewInstructions } from './prompts';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';

export async function runArchitectureReview(args: {
  runId: string; nodeId: string; nodeKey: string; definition: GraphDefinition;
  commits: { repository: string; commit: string }[];
  workspaces: ReviewWorkspace[]; evidence: VerificationEvidence;
}): Promise<'passed' | 'failed' | 'running'> {
  const node = args.definition.nodes.find((item) => item.key === args.nodeKey);
  if (!node) throw new Error(`Unknown graph node ${args.nodeKey}`);
  const review = effectiveArchitectureReview(args.definition, node);
  if (!review) return 'passed'; // Runs created before architecture review was introduced.
  const resultKey = `node:${args.nodeKey}:architecture_result`;
  const existing = await prisma.taskGraphEvent.findUnique({
    where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: resultKey } },
  });
  if (existing) return (existing.payload as { approved?: boolean }).approved === true ? 'passed' : 'failed';
  const claimKey = `node:${args.nodeKey}:architecture_claimed`;
  try {
    await prisma.taskGraphEvent.create({ data: {
      runId: args.runId, nodeId: args.nodeId, idempotencyKey: claimKey,
      kind: 'architecture_claimed', payload: { reviewerId: review.reviewerId },
    } });
  } catch (error) {
    const claim = await prisma.taskGraphEvent.findUnique({
      where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: claimKey } },
    });
    if (claim) return 'running';
    throw error;
  }
  const participant = (review.reviewLaunchConfig as { participant?: AcpxParticipantRequest }).participant;
  if (!participant) throw new Error(`Architecture reviewer missing for ${args.nodeKey}`);
  const taskId = `task-graph-architecture-${args.nodeId}`;
  const task = await prisma.task.upsert({ where: { id: taskId }, create: {
    id: taskId, name: `${args.nodeKey} · 架构复核`, executionMode: 'acpx', status: 'pending',
    acpxParticipants: JSON.stringify([participant]),
    description: `独立检查任务图 ${args.runId} / ${args.nodeKey} 的变更范围与架构影响。`,
    workingDirectory: args.workspaces.at(-1)?.path || null,
  }, update: { workingDirectory: args.workspaces.at(-1)?.path || null } });
  const prompt = `${architectureReviewInstructions}\n请检查 ${args.nodeKey}。` +
    `\n目标：${node.goal}\nSpec：${args.definition.specRef}` +
    `\n固定提交：${JSON.stringify(args.commits)}` +
    `\n仓库检出目录：${JSON.stringify(args.workspaces)}` +
    `\n交付证据：${JSON.stringify(args.evidence)}` +
    '\n最终答复仅用一行 TASK_GRAPH_ARCH_REVIEW {"approved":true或false,"note":"具体依据"}。';
  const reviewRun = await executeAcpxTaskRun({
    taskId: task.id, taskName: task.name, taskDescription: prompt,
    orchestrationMode: 'single', participants: [participant],
    extraReadOnlyPaths: args.workspaces.map((workspace) => workspace.path),
    workingDirectory: task.workingDirectory || undefined, permissionConfig: taskGraphAgentReviewPermissionConfig,
  }).catch((error) => ({ status: 'failed', taskRunId: 'not-created', participants: [],
    summary: error instanceof Error ? error.message : String(error) }));
  const response = reviewRun.participants[0]?.summary || reviewRun.summary || '';
  const match = response.match(/TASK_GRAPH_ARCH_REVIEW\s*(\{[^\r\n]+\})/);
  let decision: { approved?: unknown; note?: unknown } = {};
  try { decision = match ? JSON.parse(match[1]) as typeof decision : {}; } catch { /* invalid result fails closed */ }
  let approved = reviewRun.status === 'completed' && decision.approved === true &&
    typeof decision.note === 'string' && decision.note.trim().length > 0;
  let note = String(decision.note || response || '没有有效的结构化结论');
  try { await assertReviewWorkspacesClean(args.workspaces); } catch (error) {
    approved = false;
    note += `；固定提交工作区被修改：${String(error)}`;
  }
  await prisma.taskGraphEvent.create({ data: {
    runId: args.runId, nodeId: args.nodeId, idempotencyKey: resultKey,
    kind: approved ? 'architecture_passed' : 'architecture_failed',
    payload: { approved, note, reviewerId: review.reviewerId,
      taskRunId: reviewRun.taskRunId, commits: args.commits } as Prisma.InputJsonValue,
  } });
  return approved ? 'passed' : 'failed';
}
