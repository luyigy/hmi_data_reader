import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { executionProgress } from './execution-progress';
import { observeTaskRunWriter, type WriterObservation } from './writer-ownership';

/** Exit observations are usable only for the exact ledger and TaskRun identities observed. */
type SnapshotRequest = { jobs: TaskGraphExecution[]; taskRunIds?: string[] } & (
  { scope: 'execution'; observeExecution: (job: TaskGraphExecution) => Promise<WriterObservation> } | { scope: 'review-model' }
);
export async function observeWriterSnapshot(args: SnapshotRequest) {
  const { jobs, taskRunIds: extraTaskRunIds = [] } = args;
  const ids = new Set(extraTaskRunIds);
  for (const job of jobs) {
    const progress = executionProgress(job.dispatchMetadata);
    for (const id of [job.taskRunId, progress?.taskRunId, progress?.review?.kind === 'running' ? progress.review.taskRunId : null,
      progress?.conversation?.kind === 'running' ? progress.conversation.taskRunId : null]) if (id) ids.add(id);
  }
  const runs = await prisma.taskRun.findMany({ where: { id: { in: Array.from(ids) } }, include: { participants: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } });
  const observations = [];
  if (args.scope === 'execution') for (const job of jobs) observations.push(await args.observeExecution(job));
  for (const id of extraTaskRunIds) observations.push(await observeTaskRunWriter(id));
  return { jobs, runs, taskRunIds: Array.from(ids), observations, exited: observations.every(value => value.kind === 'exited') };
}

export async function writerSnapshotMatches(tx: Prisma.TransactionClient, proof: Awaited<ReturnType<typeof observeWriterSnapshot>>) {
  if (!proof.exited) return false;
  const jobs = await tx.taskGraphExecution.findMany({ where: { id: { in: proof.jobs.map(job => job.id) } }, orderBy: { id: 'asc' } });
  if (!isDeepStrictEqual(jobs, [...proof.jobs].sort((a, b) => a.id.localeCompare(b.id)))) return false;
  const runs = await tx.taskRun.findMany({ where: { id: { in: proof.taskRunIds } }, include: { participants: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } });
  return isDeepStrictEqual(runs, proof.runs);
}
