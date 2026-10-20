import { prisma } from '../prisma';
import { applyExecutionOutcomeTx, executionProgress } from './execution-progress';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';

/** The caller authorizes recovery; this transaction durably binds its new review generation. */
export async function scheduleVerificationRecovery(runId: string, nodeKey: string, requestId: string) {
  if (!requestId.trim()) throw new Error('Verification recovery requires a request identity');
  const key = `node:${nodeKey}:verification-recovery:${requestId}`;
  if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } })) return;
  const before = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true } });
  const taskIds = [`task-graph-review-${before.id}`, `task-graph-architecture-${before.id}`];
  const ids = before.executions.flatMap(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.kind === 'running' ? [binding.taskRunId] : []; });
  // The old platform worker may still be cleaning up. Only its model must have exited here;
  // the coordinator checks the platform worker again before starting this generation.
  const proof = await observeWriterSnapshot({ jobs: before.executions, taskRunIds: ids, scope: 'review-model' });
  if (!proof.exited) throw new Error(`Verification writer has not demonstrably exited: ${JSON.stringify(proof.observations)}`);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${before.id} FOR UPDATE`;
    if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } })) return;
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: before.id }, include: { executions: true } });
    if (current.executions.length !== proof.jobs.length) throw new Error('Recovery execution membership changed');
    if (current.status !== 'attention' || !await writerSnapshotMatches(tx, proof)) throw new Error('Verification recovery identity changed or writer has not demonstrably exited');
    if (!current.executions.length || current.executions.some(job => !job.commit || ['exhausted', 'ownership_attention'].includes(executionProgress(job.dispatchMetadata)?.state || ''))) throw new Error('Verification recovery requires an explicit exhaustion or ownership decision');
    if (await tx.taskRun.count({ where: { taskId: { in: taskIds }, status: { in: ['pending', 'running', 'waiting_for_input'] } } })) throw new Error('Verification still has a live TaskRun');
    const claimKey = `recovery:${key}`;
    for (const job of current.executions) {
      const progress = executionProgress(job.dispatchMetadata);
      if (!progress || !job.claimToken || !(job.status === 'attention' && progress.state === 'waiting_decision' || job.status === 'integrated' && ['active', 'ready'].includes(progress.state))) throw new Error('Verification inputs changed before recovery');
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
        outcomeId: key, outcome: { kind: 'review_resumed', claimKey } });
    }
    await tx.taskGraphNode.update({ where: { id: current.id }, data: { status: 'verifying' } });
    await tx.taskGraphEvent.create({ data: { runId, nodeId: current.id, idempotencyKey: key, kind: 'verification_recovery_requested',
      payload: { requestId, claimKey, executionIds: current.executions.map(job => job.id) } } });
  });
}
