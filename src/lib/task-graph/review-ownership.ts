import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { executionProgress, metadataWithProgress, type GraphReviewBinding } from './execution-progress';

export async function graphReviewClaimKey(nodeId: string, phase: 'architecture' | 'acceptance', fallbackClaimKey: string) {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId } });
  const bindings = jobs.map(job => executionProgress(job.dispatchMetadata)?.review).filter((binding): binding is GraphReviewBinding => binding !== undefined && binding.phase === phase && binding.kind === 'ready');
  if (!bindings.length) return fallbackClaimKey;
  const keys = new Set(bindings.map(binding => binding.claimKey));
  if (keys.size !== 1 || bindings.length !== jobs.length) throw new Error('Review restart identity is inconsistent');
  return bindings[0].claimKey;
}

export async function bindGraphReviewTaskRun(tx: Prisma.TransactionClient, args: { runId: string; nodeId: string; phase: 'architecture' | 'acceptance'; claimKey: string }, taskRunId: string) {
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${args.nodeId} FOR UPDATE`;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: args.nodeId }, include: { executions: true } });
  if (node.runId !== args.runId || node.status !== 'verifying') throw new Error('Review node no longer owns verification');
  const claim = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: args.claimKey } } });
  if (!claim || claim.nodeId !== node.id || claim.kind !== (args.phase === 'architecture' ? 'architecture_claimed' : 'review_claimed')) throw new Error('Review has no matching durable claim');
  for (const job of node.executions) {
    const progress = executionProgress(job.dispatchMetadata);
    if (job.status !== 'integrated' || !progress || !job.commit) throw new Error('Review input has no integrated progress');
    if (progress.review?.kind === 'running') {
      const previous = await tx.taskRun.findUnique({ where: { id: progress.review.taskRunId } });
      if (previous && ['pending', 'running', 'waiting_for_input'].includes(previous.status)) throw new Error('Previous review TaskRun still owns this input');
    }
    if (progress.review?.kind === 'ready' && progress.review.claimKey !== args.claimKey) throw new Error('Review claim was superseded');
    await tx.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...progress, revision: progress.revision + 1, phase: args.phase, candidateCommit: job.commit,
        review: { phase: args.phase, claimKey: args.claimKey, kind: 'running', taskRunId } }) } });
  }
  await tx.taskGraphEvent.create({ data: { runId: args.runId, nodeId: node.id, kind: 'review_dispatched',
    idempotencyKey: `review-dispatched:${taskRunId}`, payload: { ...args, taskRunId } } });
}

export async function assertGraphReviewOwnership(nodeId: string, phase: 'architecture' | 'acceptance', claimKey: string, taskRunId: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  if (node.status !== 'verifying' || !node.executions.length || node.executions.some(job => {
    const binding = executionProgress(job.dispatchMetadata)?.review;
    return job.status !== 'integrated' || binding?.kind !== 'running' || binding.phase !== phase || binding.claimKey !== claimKey || binding.taskRunId !== taskRunId;
  })) throw new Error('Review ownership changed before result publication');
}
