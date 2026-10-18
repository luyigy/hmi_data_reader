import type { Prisma } from '@prisma/client';
import { observeTaskRunWriter } from './writer-ownership';
import { prisma } from '../prisma';
import { executionProgress, initialExecutionProgress, metadataWithProgress, type GraphReviewBinding } from './execution-progress';

export async function graphReviewClaimKey(nodeId: string, phase: 'architecture' | 'acceptance', fallbackClaimKey: string) {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId } });
  const bindings = jobs.map(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.phase === phase && binding.candidateCommit === job.commit ? binding : undefined; })
    .filter((binding): binding is GraphReviewBinding => binding !== undefined);
  if (!bindings.length) return fallbackClaimKey;
  const keys = new Set(bindings.map(binding => binding.claimKey));
  if (keys.size !== 1 || bindings.length !== jobs.length) {
    if (bindings.some(binding => binding.kind === 'ready')) throw new Error('Review restart identity is inconsistent');
    return fallbackClaimKey;
  }
  return bindings[0].claimKey;
}

export async function bindGraphReviewTaskRun(tx: Prisma.TransactionClient, args: { runId: string; nodeId: string; phase: 'architecture' | 'acceptance'; claimKey: string }, taskRunId: string) {
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${args.nodeId} FOR UPDATE`;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: args.nodeId }, include: { executions: true } });
  if (node.runId !== args.runId || node.status !== 'verifying') throw new Error('Review node no longer owns verification');
  const claim = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: args.claimKey } } });
  if (!claim || claim.nodeId !== node.id || claim.kind !== (args.phase === 'architecture' ? 'architecture_claimed' : 'review_claimed')) throw new Error('Review has no matching durable claim');
  for (const job of node.executions) {
    if (job.status !== 'integrated' || !job.commit || !/^[0-9a-f]{40,64}$/.test(job.commit)) throw new Error('Review input has no integrated commit');
    const previousProgress = executionProgress(job.dispatchMetadata);
    const progress = previousProgress || { ...initialExecutionProgress(), phase: args.phase, workspaceBase: job.baseCommit, candidateCommit: job.commit };
    if (!previousProgress) await tx.taskGraphEvent.create({ data: { runId: args.runId, nodeId: node.id,
      idempotencyKey: `review-progress-adopted:${job.id}`, kind: 'review_progress_adopted', payload: { executionId: job.id, integratedCommit: job.commit, phase: args.phase } } });
    if (progress.review?.kind === 'running') {
      const previous = await tx.taskRun.findUnique({ where: { id: progress.review.taskRunId } });
      if (previous && ['pending', 'running', 'waiting_for_input'].includes(previous.status)) throw new Error('Previous review TaskRun still owns this input');
    }
    if (progress.review?.kind === 'ready' && progress.review.claimKey !== args.claimKey) throw new Error('Review claim was superseded');
    await tx.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: job.claimToken || `review-owner:${taskRunId}`, dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...progress, revision: progress.revision + 1, phase: args.phase, candidateCommit: job.commit,
        review: { phase: args.phase, claimKey: args.claimKey, kind: 'running', taskRunId, candidateCommit: job.commit } }) } });
  }
  await tx.taskGraphEvent.create({ data: { runId: args.runId, nodeId: node.id, kind: 'review_dispatched',
    idempotencyKey: `review-dispatched:${taskRunId}`, payload: { ...args, taskRunId } } });
}

export async function assertGraphReviewOwnership(nodeId: string, phase: 'architecture' | 'acceptance', claimKey: string, taskRunId: string) {
  return prisma.$transaction(tx => assertGraphReviewOwnershipTx(tx, nodeId, phase, claimKey, taskRunId));
}

export async function assertGraphReviewOwnershipTx(tx: Prisma.TransactionClient, nodeId: string, phase: 'architecture' | 'acceptance', claimKey: string, taskRunId: string) {
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  if (node.status !== 'verifying' || !node.executions.length || node.executions.some(job => {
    const binding = executionProgress(job.dispatchMetadata)?.review;
    return job.status !== 'integrated' || binding?.kind !== 'running' || binding.phase !== phase || binding.claimKey !== claimKey || binding.taskRunId !== taskRunId || binding.candidateCommit !== job.commit;
  })) throw new Error('Review ownership changed before result publication');
}

export async function completedGraphReviewTaskRun(nodeId: string, phase: 'architecture' | 'acceptance', claimKey: string) {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId } });
  const bindings = jobs.map(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.candidateCommit === job.commit ? binding : undefined; });
  const binding = bindings[0];
  if (!binding || binding.kind !== 'running' || binding.phase !== phase || binding.claimKey !== claimKey ||
      bindings.some(item => item?.kind !== 'running' || item.taskRunId !== binding.taskRunId || item.claimKey !== claimKey)) return null;
  const run = await prisma.taskRun.findUnique({ where: { id: binding.taskRunId }, select: { status: true } });
  return run?.status === 'completed' && (await observeTaskRunWriter(binding.taskRunId)).kind === 'exited' ? binding.taskRunId : null;
}
