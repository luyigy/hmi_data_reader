import type { TaskGraphExecution, Prisma } from '@prisma/client';
import { completeExecutionFailure, executionProgress, type ExecutionProgress, type ExecutionFailure } from './execution-progress';
import { parseImplementationResult } from './implementation-result';
import { prisma } from '../prisma';

/** Only recorded conversation reservations and worker releases may bridge a wait's revision. */
async function sameWaitingRevision(job: TaskGraphExecution, saved: ExecutionProgress, current: ExecutionProgress, db: Prisma.TransactionClient) {
  if (saved.revision === current.revision) return true;
  if (saved.revision > current.revision) return false;
  const reservations = await db.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'conversation_followup_reserved', AND: [
    { payload: { path: ['executionId'], equals: job.id } },
    { payload: { path: ['expectedRevision'], gte: saved.revision, lt: current.revision } },
  ] }, select: { payload: true } });
  const turns = new Map<number, string>();
  for (const { payload } of reservations) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.expectedRevision !== 'number') return false;
    const worker = payload.worker;
    if (!worker || typeof worker !== 'object' || Array.isArray(worker) || typeof worker.nonce !== 'string' || turns.has(payload.expectedRevision)) return false;
    turns.set(payload.expectedRevision, worker.nonce);
  }
  const nonces = [...Array.from(turns.values()), ...(saved.worker ? [saved.worker.nonce] : [])];
  const releases = await db.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'phase_worker_released',
    idempotencyKey: { in: nonces.flatMap(nonce => [`execution-worker-released:${nonce}`, `review-worker-released:${nonce}`]) },
    OR: [{ payload: { path: ['executionId'], equals: job.id } }, { payload: { path: ['executionIds'], array_contains: [job.id] } }],
  }, select: { payload: true } });
  const releasedNonces = new Set(releases.flatMap(({ payload }) => payload && typeof payload === 'object' && !Array.isArray(payload) &&
    typeof payload.nonce === 'string' ? [payload.nonce] : []));
  let revision = saved.revision, nonce = saved.worker?.nonce, released = Boolean(saved.workerReleasedAt);
  while (revision < current.revision) {
    const next = turns.get(revision);
    if (next) { nonce = next; released = false; }
    else if (nonce && !released && releasedNonces.has(nonce)) released = true;
    else return false;
    revision++;
  }
  return nonce === current.worker?.nonce && released === Boolean(current.workerReleasedAt);
}

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
  if (!saved || saved.state !== progress.state || saved.phase !== progress.phase || saved.workspaceBase !== progress.workspaceBase ||
      saved.candidateCommit !== progress.candidateCommit || saved.taskRunId !== progress.taskRunId ||
      !await sameWaitingRevision(job, saved, progress, db)) return null;
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
