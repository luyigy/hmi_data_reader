import type { TaskGraphExecution, Prisma } from '@prisma/client';
import { completeExecutionFailure, executionProgress, type ExecutionProgress, type ExecutionFailure } from './execution-progress';
import { parseImplementationResult } from './implementation-result';
import { prisma } from '../prisma';

/** Restore only the current wait, never a cause from a previous execution turn. */
export async function currentWaitCause(job: TaskGraphExecution, progress: ExecutionProgress, db: Prisma.TransactionClient = prisma): Promise<ExecutionFailure | null> {
  const latest = await db.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId, kind: { in: ['execution_outcome', 'implementation_blocked'] },
    payload: { path: ['executionId'], equals: job.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const payload = latest?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.claimToken !== job.claimToken) return null;
  if (latest.kind === 'implementation_blocked') {
    const result = payload.result;
    if (payload.taskRunId !== job.taskRunId || payload.checkpointCommit !== progress.candidateCommit ||
        !result || typeof result !== 'object' || Array.isArray(result) || typeof result.blockerKind !== 'string' || typeof result.note !== 'string') return null;
    return completeExecutionFailure({ code: result.blockerKind, detail: result.note });
  }
  const saved = executionProgress({ progress: payload.progress });
  if (!saved || saved.state !== progress.state || saved.candidateCommit !== progress.candidateCommit || saved.taskRunId !== progress.taskRunId) return null;
  const reservation = progress.conversation ? await db.taskGraphEvent.findUnique({ where: { id: progress.conversation.reservationId } }) : null;
  const reserved = reservation?.payload;
  const waitRevision = reserved && typeof reserved === 'object' && !Array.isArray(reserved) && typeof reserved.expectedRevision === 'number'
    ? reserved.expectedRevision : progress.revision;
  if (saved.revision !== waitRevision) {
    // Releasing the wait's phase worker advances the revision without starting a new wait.
    if (saved.revision + 1 !== waitRevision || !saved.worker || !await db.taskGraphEvent.count({ where: {
      nodeId: job.nodeId, kind: 'phase_worker_released', idempotencyKey: `execution-worker-released:${saved.worker.nonce}`,
      payload: { path: ['executionId'], equals: job.id } } })) return null;
  }
  const outcome = payload.outcome;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  if (outcome.kind === 'waiting_for_user') {
    if (outcome.failure) return executionProgress({ progress: { ...saved, lastFailure: outcome.failure } })?.lastFailure || null;
    if (outcome.result === 'question' || outcome.result === 'answered') return { code: 'question', detail: saved.waitingMessage || 'Recorded ordinary question', requiresUserDecision: false };
    // Older permission waits lost their cause in this outcome; inspect the bound result rather than guessing from the note.
    if (!job.taskRunId || saved.taskRunId !== job.taskRunId) return null;
    const run = await db.taskRun.findUnique({ where: { id: job.taskRunId }, include: { participants: true } });
    if (run?.status !== 'completed') return null;
    try {
      const result = parseImplementationResult(run.participants[0]?.summary || run.summary || '');
      if (result.status === 'blocked') return completeExecutionFailure({ code: result.blockerKind, detail: result.note });
      if (result.status === 'waiting_for_user' || result.status === 'answered') return { code: 'question', detail: result.note, requiresUserDecision: false };
    } catch { return null; }
    return null;
  }
  return saved.lastFailure || null;
}
