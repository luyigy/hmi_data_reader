import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { isRecord } from './implementation-result';
import { parseGraphResult } from './result-protocol';
import type { ResultBinding } from './task-run-result';

export type ResultSource = { executionId: string; directory: string; commit: string; tree: string; dirty: boolean };
export type ResultCompletion = { outputHash: string; sources: ResultSource[]; error?: string };
export const resultOutputHash = (output: string) => createHash('sha256').update(output).digest('hex');

/** Capture the final source while the runner still owns its writer, before another turn can start. */
export async function captureRoomResultSource(taskRunId: string) {
  const turn = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const metadata = JSON.parse(turn.controlMetadata || '{}');
  const binding = metadata.graphResultBinding as ResultBinding | undefined;
  if (!binding || binding.source !== 'room' && binding.deliveryContract !== 'agent_commit_v1') return;
  const output = turn.participants[0]?.summary || turn.summary || '';
  const result = parseGraphResult(output, binding.marker || '', binding.checks);
  const formal = binding.authorized && turn.participants.length === 1 && turn.participants[0].status === 'completed' &&
    (result.kind === 'review' || result.kind === 'implementation' && result.result.status === 'delivered');
  const completion: ResultCompletion = { outputHash: resultOutputHash(output), sources: [] };
  if (formal) {
    try {
      const runtime = binding.source === 'room' ? await prisma.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: {
        runId: binding.runId, idempotencyKey: `room-runtime:${taskRunId}`,
      } } }) : null;
      if (runtime && (!isRecord(runtime.payload) || runtime.payload.taskRunId !== taskRunId || !Array.isArray(runtime.payload.sources))) throw new Error('Missing source runtime receipt');
      const jobs = await prisma.taskGraphExecution.findMany({ where: { id: { in: binding.executionIds }, nodeId: binding.nodeId } });
      for (const job of jobs) {
        const runtimeSources = runtime && isRecord(runtime.payload) && Array.isArray(runtime.payload.sources) ? runtime.payload.sources : [{ key: job.key, repository: job.repository, directory: job.worktreePath }];
        const sources = runtimeSources.filter(source => isRecord(source) && source.key === job.key && source.repository === job.repository);
        const source = sources[0];
        if (sources.length !== 1 || !isRecord(source) || typeof source.directory !== 'string') throw new Error('Ambiguous result source directory');
        const directory = source.directory;
        const commit = await graphGit(directory, 'rev-parse', 'HEAD');
        const tree = await graphGit(directory, 'rev-parse', 'HEAD^{tree}');
        const dirty = Boolean(await graphGit(directory, 'status', '--porcelain', '--untracked-files=all'));
        completion.sources.push({ executionId: job.id, directory, commit, tree, dirty });
      }
      completion.sources.sort((a, b) => a.executionId.localeCompare(b.executionId));
      if (jobs.length !== binding.executionIds.length) throw new Error('Incomplete final source set');
    } catch (error) { completion.error = error instanceof Error ? error.message : String(error); }
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${taskRunId} FOR UPDATE`;
    const current = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
    const saved = JSON.parse(current.controlMetadata || '{}');
    if (saved.graphResultCompletion && !isDeepStrictEqual(saved.graphResultCompletion, completion)) throw new Error('Final result source is immutable');
    await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...saved,
      graphResultCompletion: completion, graphRoomResultPending: binding.source === 'room' && formal }) } });
  });
}

export async function completedRoomSource(tx: Prisma.TransactionClient, taskRunId: string) {
  const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const metadata = JSON.parse(turn.controlMetadata || '{}');
  const completion = metadata.graphResultCompletion as ResultCompletion | undefined;
  if (turn.status !== 'completed' || !completion || completion.error || !completion.sources.length ||
      completion.sources.some(source => source.dirty) || completion.outputHash !== resultOutputHash(turn.participants[0]?.summary || turn.summary || '')) {
    throw new Error(completion?.error || 'Formal result requires a clean committed final source and unchanged output');
  }
  return completion;
}
