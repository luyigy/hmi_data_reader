import { assertPendingReviewRepairTx, type PendingReviewRepairBinding } from './pending-review-repair-contract';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { VerificationEvidence } from './store';
import { classifyReview, graphReviewChecks, type ReviewDecision } from './review-contract';
import type { GraphDefinition } from './domain';
import { applyExecutionOutcomeTx, executionProgress, initialExecutionProgress, metadataWithProgress } from './execution-progress';
import { executionRetryLimits } from './retry-limits';
export type { ReviewDecision } from './review-contract';
export const MAX_AUTO_REPAIR_ATTEMPTS = executionRetryLimits.repairAttempts;

/** Only a classified, approved-scope defect can requeue the original implementation jobs. */
export async function scheduleGraphRepair(runId: string, nodeKey: string, decision: ReviewDecision, evidence: VerificationEvidence, expectedReview?: PendingReviewRepairBinding) {
  if (decision.approved === true || decision.failureKind !== 'in_scope_defect' || typeof decision.note !== 'string' || !decision.note.trim()) return false;
  return prisma.$transaction(async tx => {
    const found = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, select: { id: true } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${found.id} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: found.id }, include: { executions: true, run: true } });
    if (expectedReview) await assertPendingReviewRepairTx(tx, node.id, expectedReview, decision, evidence);
    if (node.status !== 'attention' || node.executions.some(job => job.status !== 'integrated')) return false;
    const classified = classifyReview({ ...decision, approved: false }, graphReviewChecks(node.run.snapshot as unknown as GraphDefinition, nodeKey, node.executions));
    if (!classified || classified.approved || classified.failureKind !== 'in_scope_defect') return false;
    const { note, failureKey, executionIds } = classified;
    const targets = node.executions.filter(job => executionIds.includes(job.id));
    const previous = await tx.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
    const exhausted = previous >= MAX_AUTO_REPAIR_ATTEMPTS || targets.some(job => (executionProgress(job.dispatchMetadata)?.repairAttempts || 0) >= MAX_AUTO_REPAIR_ATTEMPTS);
    if (exhausted) {
      await tx.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repair:exhausted`, kind: 'node_repair_exhausted', payload: { attempts: previous, note, evidence } }], skipDuplicates: true });
    }
    const attempt = previous + 1;
    const fingerprint = createHash('sha256').update(failureKey).digest('hex');
    if (!exhausted) await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repair:${attempt}`, kind: 'node_repair_scheduled',
      payload: { attempt, fingerprint, failureKey, executionIds, note, evidence,
        previousExecutions: node.executions.map(job => ({ id: job.id, key: job.key, commit: job.commit, evidence: job.evidence, taskRunId: job.taskRunId, sessionId: job.sessionId, dispatchMetadata: job.dispatchMetadata })) } } });
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
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: token, expectedRevision: progress.revision,
        outcomeId: exhausted ? 'review-repair:exhausted' : `review-repair:${attempt}`, outcome: { kind: exhausted ? 'retry_exhausted' : 'repair_required', failure: { code: 'in_scope_defect', detail: note, checkId: failureKey, fingerprint } } });
    }
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { passedAt: null } });
    return !exhausted;
  });
}

export async function latestGraphRepair(nodeId: string) {
  return prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: 'node_repair_scheduled' }, orderBy: { createdAt: 'desc' } });
}
