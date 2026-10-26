import { isDeepStrictEqual } from 'node:util';
import { executionProgress } from './execution-progress';
import { verificationInputs } from './domain';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AcpxParticipantRequest } from '../acpx/types';
import { collectGraphReview } from './review-result';
import { graphReviewChecks, reviewResultInstructions } from './review-contract';
import { graphReviewClaimKey, reserveGraphReviewClaim, assertGraphReviewOwnershipTx, completedGraphReviewTaskRun } from './review-ownership';
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
  // Acceptance recovery must reuse the successful architecture generation, including a retry claim.
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: args.nodeId } });
  if (jobs.length && jobs.every(job => executionProgress(job.dispatchMetadata)?.phase === 'acceptance')) {
    const latest = await prisma.taskGraphEvent.findFirst({ where: { nodeId: args.nodeId,
      kind: { in: ['architecture_passed', 'architecture_failed'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const payload = latest?.payload;
    if (latest?.kind === 'architecture_passed' && payload && typeof payload === 'object' && !Array.isArray(payload) &&
        payload.reviewerId === review.reviewerId && isDeepStrictEqual(payload.commits, args.commits) &&
        (args.definition.deliveryContract !== 'agent_owned_v1' || isDeepStrictEqual(payload.inputs, verificationInputs(jobs)))) return 'passed';
  }
  const basis = createHash('sha256').update(JSON.stringify(args.commits)).digest('hex').slice(0, 24);
  const fallbackClaimKey = `node:${args.nodeKey}:architecture_claimed:${basis}`;
  const claimKey = await graphReviewClaimKey(args.nodeId, 'architecture', fallbackClaimKey);
  const resultKey = `node:${args.nodeKey}:architecture_result:${createHash('sha256').update(claimKey).digest('hex').slice(0, 24)}`;
  const existing = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: resultKey } } });
  if (existing) return (existing.payload as { approved?: boolean }).approved === true ? 'passed' : 'failed';
  const claimed = await reserveGraphReviewClaim({ runId: args.runId, nodeId: args.nodeId, phase: 'architecture', claimKey, payload: { reviewerId: review.reviewerId } });
  if (!claimed && !await completedGraphReviewTaskRun(args.nodeId, 'architecture', claimKey)) return 'running';
  const participant = (review.reviewLaunchConfig as { participant?: AcpxParticipantRequest }).participant;
  if (!participant) throw new Error(`Architecture reviewer missing for ${args.nodeKey}`);
  const taskId = `task-graph-architecture-${args.nodeId}`;
  const task = await prisma.task.upsert({ where: { id: taskId }, create: {
    id: taskId, name: `${args.nodeKey} · 架构复核`, executionMode: 'acpx', status: 'pending',
    acpxParticipants: JSON.stringify([participant]),
    description: `独立检查任务图 ${args.runId} / ${args.nodeKey} 的变更范围与架构影响。`,
    workingDirectory: args.workspaces.at(-1)?.path || null,
  }, update: { workingDirectory: args.workspaces.at(-1)?.path || null } });
  const executions = await prisma.taskGraphExecution.findMany({ where: { nodeId: args.nodeId }, select: { id: true, repository: true, key: true, commit: true } });
  const checks = graphReviewChecks(args.definition, args.nodeKey, executions);
  const prompt = `${architectureReviewInstructions}\n请检查 ${args.nodeKey}。` +
    `\n目标：${node.goal}\nSpec：${args.definition.specRef}` +
    `\n固定提交：${JSON.stringify(args.commits)}` +
    `\n仓库检出目录：${JSON.stringify(args.workspaces)}` +
    `\n交付证据：${JSON.stringify(args.evidence)}` +
    reviewResultInstructions('TASK_GRAPH_ARCH_REVIEW', checks);
  const result = await collectGraphReview({ runId: args.runId, nodeId: args.nodeId, claimKey, marker: 'TASK_GRAPH_ARCH_REVIEW', checks,
    request: { graphReview: { runId: args.runId, nodeId: args.nodeId, phase: 'architecture', claimKey },
      taskId: task.id, taskName: task.name, taskDescription: prompt,
      orchestrationMode: 'single', participants: [participant],
      extraReadOnlyPaths: args.workspaces.map(workspace => workspace.path),
      workingDirectory: task.workingDirectory || undefined, permissionConfig: taskGraphAgentReviewPermissionConfig } });
  if (result.taskRunId === 'not-created') throw new Error(result.kind === 'classified' ? 'Review did not launch' : result.note);
  let workspaceInvalid = false;
  let approved = result.kind === 'classified' && result.decision.approved;
  let note = result.kind === 'classified' ? result.decision.note : result.note;
  try { await assertReviewWorkspacesClean(args.workspaces); } catch (error) {
    approved = false; workspaceInvalid = true;
    note += `；固定提交工作区被修改：${String(error)}`;
  }
  await prisma.$transaction(async tx => {
  await assertGraphReviewOwnershipTx(tx, args.nodeId, 'architecture', claimKey, result.taskRunId);
  await tx.taskGraphEvent.create({ data: {
    runId: args.runId, nodeId: args.nodeId, idempotencyKey: resultKey,
    kind: approved ? 'architecture_passed' : 'architecture_failed',
    payload: { ...(workspaceInvalid ? { failureKind: 'ownership_mismatch' } : result.kind === 'classified' ? result.decision : { failureKind: result.kind }), approved, note, reviewerId: review.reviewerId,
      taskRunId: result.taskRunId, claimKey, commits: args.commits, ...(args.definition.deliveryContract === 'agent_owned_v1' ? { inputs: verificationInputs(executions) } : {}) } as Prisma.InputJsonValue,
  } });
  });
  return approved ? 'passed' : 'failed';
}
