import { transientPlatformCode } from './platform-failure';
import { RuntimePreparationError } from './runtime-preflight';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { executionRetryLimits } from './retry-limits';
import { TaskInputPreparationError } from './upstream-inputs';
import { ServiceRuntimeError } from './attempt-services';
import { GraphCheckTimeoutError } from './check-runner';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { graphRunCanStartTx } from './run-control';
import { applyExecutionOutcomeTx, executionProgress, initialExecutionProgress, metadataWithProgress, type ExecutionFailure } from './execution-progress';

export type ReviewPublication = {
  phase: 'architecture' | 'acceptance'; claimKey: string; taskRunId: string;
  outcome: 'classified' | 'protocol_exhausted' | 'platform_failure';
  decision?: { code: 'blocked_require_human' | 'ownership_mismatch' | 'environment_failed'; detail: string };
};

/** Caller holds graph-control before node; a platform retry never dispatches implementation again. */
export async function applyReviewFailureTx(tx: Prisma.TransactionClient, nodeId: string, args: {
  phase: 'architecture' | 'acceptance'; claimKey: string; identity: string;
  failure: ExecutionFailure; kind: 'platform_failure' | 'protocol_exhausted' | 'decision_required' | 'business_failed';
}) {
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: node.runId }, select: { snapshot: true } });
  const snapshot = run.snapshot;
  const businessBlocked = args.kind === 'decision_required' && ['blocked_require_human', 'environment_failed'].includes(args.failure.code) &&
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && snapshot.deliveryContract === 'agent_owned_v1';
  if (node.status !== 'verifying' || !node.executions.length) throw new Error('Review failure no longer owns verification');
  const exhausted = args.kind === 'protocol_exhausted' || args.kind === 'platform_failure' && node.executions.some(job => (executionProgress(job.dispatchMetadata)?.platformAttempts || 0) >= executionRetryLimits.platformAttempts);
  const failure: ExecutionFailure = args.kind === 'platform_failure' ? { ...args.failure, owner: 'platform', requiresUserDecision: false } : args.failure;
  const nextClaim = `${args.claimKey}:platform:${Math.max(...node.executions.map(job => executionProgress(job.dispatchMetadata)?.platformAttempts || 0)) + 1}`;
  for (const job of node.executions) {
    if (job.status !== 'integrated' || !job.commit) throw new Error('Review failure input is not integrated');
    let progress = executionProgress(job.dispatchMetadata);
    if (!progress) {
      progress = { ...initialExecutionProgress(), phase: args.phase, candidateCommit: job.commit, workspaceBase: job.baseCommit };
      await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'review_progress_adopted', idempotencyKey: `review-failure-adopted:${job.id}`, payload: { executionId: job.id, integratedCommit: job.commit } } });
    }
    const token = job.claimToken || `review-preparation:${nodeId}`;
    if (!executionProgress(job.dispatchMetadata)) await tx.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: token, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, progress) } });
    else if (!job.claimToken) throw new Error('Versioned review has no claim token');
    await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: token, expectedRevision: progress.revision,
      outcomeId: `review-failure:${args.identity}`, outcome: args.kind === 'business_failed' ? { kind: 'business_stopped', result: 'failed', failure }
        : businessBlocked ? { kind: 'business_stopped', result: 'blocked', failure }
        : exhausted ? { kind: 'retry_exhausted', failure }
        : args.kind === 'decision_required' ? { kind: 'decision_required', failure }
        : { kind: 'review_retry', failure, claimKey: nextClaim, phase: args.phase } });
  }
  const status = args.kind === 'platform_failure' && !exhausted ? 'verifying' : 'attention';
  await tx.taskGraphNode.update({ where: { id: nodeId }, data: { status } });
  if (status === 'verifying') await tx.taskGraphRun.updateMany({ where: { id: node.runId, status: { not: 'paused' } }, data: { status: 'running' } });
  return status;
}

/** Preparation failures have no reviewer TaskRun; require any previous reviewer to have exited. */
export async function publishReviewPreparationFailure(nodeId: string, failure: ExecutionFailure, retry: boolean, phase: 'architecture' | 'acceptance') {
  const before = await prisma.taskGraphExecution.findMany({ where: { nodeId } });
  const ids = retry ? before.flatMap(job => {
    const binding = executionProgress(job.dispatchMetadata)?.review;
    return binding?.kind === 'running' ? [binding.taskRunId] : [];
  }) : [];
  const proof = await observeWriterSnapshot({ jobs: before, taskRunIds: ids, scope: 'review-model' });
  return prisma.$transaction(async tx => {
    const { runId } = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, select: { runId: true } });
    await graphRunCanStartTx(tx, runId);
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
    if (!await writerSnapshotMatches(tx, proof) || node.executions.length !== proof.jobs.length) throw new Error('Review preparation cannot replace an unproven writer or changed candidate');
    const identity = `preparation:${node.executions.map(job => executionProgress(job.dispatchMetadata)?.revision || 0).join(':')}`;
    const status = await applyReviewFailureTx(tx, nodeId, { phase, claimKey: `node:${node.key}:${phase}:preparation`, identity, failure,
      kind: retry ? 'platform_failure' : 'decision_required' });
    await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'review_workspace_failed', idempotencyKey: `review:${identity}`, payload: { failure, status } } });
    return status;
  });
}

export function reviewPreparationFailure(error: unknown) {
  if (error instanceof RuntimePreparationError) return { retry: true, failure: error.failure };
  const retry = Boolean(transientPlatformCode(error)) || error instanceof TaskInputPreparationError || error instanceof ServiceRuntimeError || error instanceof GraphCheckTimeoutError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
  return { retry, failure: { code: retry ? 'environment_failed' : 'ownership_mismatch', detail: error instanceof Error ? error.message : String(error) } };
}
