import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { executionProgress } from './execution-progress';
import { observeGraphWriter, observeTaskRunWriter } from './writer-ownership';
import { hasLegacyWriterRelease } from './legacy-writer-release';

/** One short transaction lock for task graph startup paths. */
export async function lockWriterAdmission(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('task-workspace-writer-admission', 0))`;
}

export class WorkspaceWriterBusy extends Error {
  constructor(readonly observation: 'alive' | 'unknown', owner: string) {
    super(`Workspace writer ${owner} is ${observation}; preserve the queued message`);
    this.name = 'WorkspaceWriterBusy';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const canonical = async (value: string) => realpath(value).catch(() => path.resolve(value));
const overlaps = (left: string, right: string) => left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);

/** Caller holds lockWriterAdmission until the claim or TaskRun is durably created. */
export async function assertWorkspaceWriterAvailable(tx: Prisma.TransactionClient, args: {
  taskId?: string; nodeId?: string; directory?: string | null; resultTaskRunId?: string;
  executionClaim?: { executionId: string; claimToken: string };
  reviewClaim?: { nodeId: string; claimKey: string };
}) {
  const directory = args.directory ? await canonical(args.directory) : null;
  const jobs = await tx.taskGraphExecution.findMany({ where: { OR: [
    ...(args.nodeId ? [{ nodeId: args.nodeId }] : []),
    ...(args.taskId ? [{ childTaskId: args.taskId }] : []),
    ...(directory ? [{ worktreePath: { not: null } }] : []),
  ] } });
  const scope = [];
  for (const job of jobs) {
    if (job.nodeId === args.nodeId || job.childTaskId === args.taskId || directory && job.worktreePath && overlaps(directory, await canonical(job.worktreePath))) scope.push(job);
  }
  for (const job of scope) {
    const ownExecution = args.executionClaim?.executionId === job.id && args.executionClaim.claimToken === job.claimToken;
    const progress = executionProgress(job.dispatchMetadata);
    const ownReview = args.reviewClaim?.nodeId === job.nodeId && progress?.review?.claimKey === args.reviewClaim.claimKey;
    if (ownExecution || ownReview) continue;
    if (progress?.worker) {
      const observed = await observeGraphWriter(progress.worker, Boolean(progress.workerReleasedAt));
      if (observed.kind !== 'exited') throw new WorkspaceWriterBusy(observed.kind, job.id);
    } else if (job.status === 'claimed') throw new WorkspaceWriterBusy('unknown', job.id);
  }
  const taskIds = new Set([...(args.taskId ? [args.taskId] : []), ...scope.flatMap(job => [job.childTaskId, `task-graph-review-${job.nodeId}`, `task-graph-architecture-${job.nodeId}`].filter((id): id is string => !!id))]);
  const currentRunIds = scope.flatMap(job => {
    const progress = executionProgress(job.dispatchMetadata);
    return [job.taskRunId, progress?.taskRunId, progress?.conversationOwnerRunId,
      progress?.conversation?.kind === 'running' ? progress.conversation.taskRunId : null,
      progress?.review?.kind === 'running' ? progress.review.taskRunId : null].filter((id): id is string => !!id);
  });
  // The latest tracked runner covers the failure-to-finally cleanup window, even
  // before a room turn is bound into execution progress. Superseded history does not.
  for (const taskId of Array.from(taskIds)) {
    const latest = await tx.taskRun.findFirst({ where: { taskId, controlMetadata: { contains: '"graphWriter"' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    if (latest) currentRunIds.push(latest.id);
  }
  const runs = await tx.taskRun.findMany({ where: { taskId: { in: Array.from(taskIds) }, OR: [
    { status: { in: ['pending', 'running', 'waiting_for_input'] } },
    { id: { in: currentRunIds } },
    { controlMetadata: { contains: '"graphRoomResultPending":true' } },
  ] }, include: { participants: true } });
  for (const run of runs) {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(run.controlMetadata || '{}'); } catch { /* Missing proof is not an exit. */ }
    if (run.id !== args.resultTaskRunId && (['pending', 'running', 'waiting_for_input'].includes(run.status) || metadata.graphRoomResultPending === true)) throw new WorkspaceWriterBusy('alive', run.id);
    if (hasLegacyWriterRelease(run)) continue;
    const observed = await observeTaskRunWriter(run.id, tx);
    if (observed.kind !== 'exited') throw new WorkspaceWriterBusy(observed.kind, run.id);
  }
}
