import { observeExecutionWriter } from './phase-worker';
import { observeTaskRunExit } from './task-run-exit-proof';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { continuationWorkFingerprint } from './continuation-work';
import { graphGit } from './git-command';
import { graphRunCanStartTx } from './run-control';
import { assertPendingReviewRepairTx, type PendingReviewRepairBinding } from './pending-review-repair-contract';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { VerificationEvidence } from './store';
import { classifyReview, graphReviewChecks, type ReviewDecision } from './review-contract';
import type { GraphDefinition } from './domain';
import { applyExecutionOutcomeTx, executionProgress, initialExecutionProgress, metadataWithProgress } from './execution-progress';
export type { ReviewDecision } from './review-contract';

/** Only a classified, approved-scope defect can requeue the original implementation jobs. */
export async function scheduleGraphRepair(runId: string, nodeKey: string, decision: ReviewDecision, evidence: VerificationEvidence, expectedReview?: PendingReviewRepairBinding) {
  if (decision.approved === true || decision.failureKind !== 'in_scope_defect' || typeof decision.note !== 'string' || !decision.note.trim()) return false;
  const observedNode = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { run: true, executions: true } });
  const proposed = classifyReview({ ...decision, approved: false }, graphReviewChecks(observedNode.run.snapshot as unknown as GraphDefinition, nodeKey, observedNode.executions));
  if (observedNode.status !== 'attention' || !proposed || proposed.approved || proposed.failureKind !== 'in_scope_defect') return false;
  const observed = observedNode.executions.filter(job => proposed.executionIds.includes(job.id));
  const writers = await observeWriterSnapshot(expectedReview
    ? { jobs: observedNode.executions, taskRunIds: [expectedReview.taskRunId], scope: 'execution', observeExecution: observeExecutionWriter }
    : { jobs: observedNode.executions, scope: 'review-model' });
  if (!writers.exited) throw new Error('Pending review repair: reviewer, phase or implementation writer has not proven exit');
  const inputs = new Map(await Promise.all(observed.map(async job => [job.id, job.commit ? {
    commit: job.commit, tree: await graphGit(job.repository, 'rev-parse', '--verify', `${job.commit}^{tree}`),
    work: await continuationWorkFingerprint(job.id, job.commit),
  } : null] as const)));
  const exits = new Map(await Promise.all(observed.map(async job => [job.id, job.taskRunId ? await observeTaskRunExit(job.taskRunId) : undefined] as const)));
  return prisma.$transaction(async tx => {
    if (!await graphRunCanStartTx(tx, runId)) return false;
    const found = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, select: { id: true } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${found.id} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: found.id }, include: { executions: true, run: true } });
    if (!await writerSnapshotMatches(tx, writers)) throw new Error('Repair writer or candidate identity changed');
    if (expectedReview) await assertPendingReviewRepairTx(tx, node.id, expectedReview, decision, evidence);
    if (node.status !== 'attention' || node.executions.some(job => job.status !== 'integrated')) return false;
    const classified = classifyReview({ ...decision, approved: false }, graphReviewChecks(node.run.snapshot as unknown as GraphDefinition, nodeKey, node.executions));
    if (!classified || classified.approved || classified.failureKind !== 'in_scope_defect') return false;
    const { note, failureKey, executionIds } = classified;
    const targets = node.executions.filter(job => executionIds.includes(job.id));
    const previous = await tx.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
    const attempt = previous + 1;
    const fingerprint = createHash('sha256').update(failureKey).digest('hex');
    await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repair:${attempt}`, kind: 'node_repair_scheduled',
      payload: { attempt, fingerprint, failureKey, executionIds, note, evidence,
        previousExecutions: node.executions.map(job => ({ id: job.id, key: job.key, commit: job.commit, evidence: job.evidence, taskRunId: job.taskRunId, sessionId: job.sessionId, dispatchMetadata: job.dispatchMetadata })) } } });
    let queued = false;
    for (const job of targets) {
      let progress = executionProgress(job.dispatchMetadata);
      let token = job.claimToken;
      if (!progress) {
        if (!job.commit) throw new Error('Cannot adopt review repair without integrated commit');
        token ||= `legacy-review:${job.id}:${attempt}`;
        progress = { ...initialExecutionProgress(), phase: 'acceptance', candidateCommit: job.commit, workspaceBase: job.baseCommit };
        await tx.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: token, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, progress) } });
        await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: `execution:${job.id}:review-progress-adopted`, kind: 'legacy_review_progress_adopted', payload: { executionId: job.id, commit: job.commit, workspaceBase: job.baseCommit, claimToken: token } } });
      }
      if (!token) throw new Error('Review repair execution has no ownership token');
      const input = inputs.get(job.id);
      if (!input || input.commit !== job.commit) throw new Error('Repair candidate identity changed');
      const next = await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: token, expectedRevision: progress.revision,
        outcomeId: `review-repair:${attempt}`, outcome: { kind: 'repair_required', failure: { code: 'in_scope_defect', detail: note, checkId: failureKey, tree: input.tree, fingerprint: createHash('sha256').update(input.work + ':' + failureKey).digest('hex') } } }, exits.get(job.id));
      queued ||= next.state === 'ready';
    }
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { passedAt: null } });
    return queued;
  });
}

export async function latestGraphRepair(nodeId: string) {
  return prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: 'node_repair_scheduled' }, orderBy: { createdAt: 'desc' } });
}
