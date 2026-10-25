import type { Prisma } from '@prisma/client';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { observeTaskRunExit, taskRunExitMatches } from '../task-graph/task-run-exit-proof';
import { directoryContains } from './model';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const metadata = (value: string | null) => record(JSON.parse(value || '{}'));
const paths = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry)) : [];

async function canonical(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error('Writer directory must be absolute');
  try { return await realpath(value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonical(parent), path.basename(value));
  }
}

const overlaps = (left: string[], right: string[]) => left.some(a => right.some(b => directoryContains(a, b) || directoryContains(b, a)));

export async function reserveResourceWriters(tx: Prisma.TransactionClient, taskRunId: string, participantId: string, baselineWrites: string[], resourceWrites: string[]): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('task-resource-writers', 0))`;
  const participant = await tx.taskRunParticipant.findUniqueOrThrow({ where: { id: participantId }, select: { taskRunId: true, executionBackend: true } });
  if (participant.taskRunId !== taskRunId || participant.executionBackend !== 'platform_local') throw new Error('Resource writer participant identity mismatch');
  const [baseline, supplemental] = await Promise.all([Promise.all(baselineWrites.map(canonical)), Promise.all(resourceWrites.map(canonical))]);
  const runs = await tx.taskRun.findMany({ where: { id: { not: taskRunId }, participants: { some: { executionBackend: 'platform_local' } },
    OR: [
      { status: { in: ['pending', 'running', 'waiting_for_input'] } },
      { controlMetadata: { contains: '"graphWriter"' } },
      { participants: { some: { executionBackend: 'platform_local', controlMetadata: { contains: '"resources"' } } } },
    ] },
    include: { task: { select: { workingDirectory: true } }, participants: { select: { executionBackend: true, controlMetadata: true } } } });
  for (const run of runs) {
    const saved = metadata(run.controlMetadata);
    const permission = record(saved.permissionConfig);
    const roots = paths(permission.writableRoots);
    const cwd = typeof saved.workingDirectory === 'string' ? saved.workingDirectory : run.task.workingDirectory;
    const base = permission.sandboxMode === 'read-only' ? [] : permission.profile === 'full_access' || permission.sandboxMode === 'danger-full-access'
      ? ['/'] : [...roots, ...(cwd ? [cwd] : [])];
    const extra = run.participants.filter(item => item.executionBackend === 'platform_local')
      .flatMap(item => paths(record(metadata(item.controlMetadata).resources).writableRoots));
    if (!supplemental.length && !extra.length) continue;
    const [otherBase, otherExtra] = await Promise.all([Promise.all(base.map(canonical)), Promise.all(extra.map(canonical))]);
    if (!overlaps(supplemental, [...otherBase, ...otherExtra]) && !overlaps(baseline, otherExtra)) continue;
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${run.id} FOR UPDATE`;
    const proof = await observeTaskRunExit(run.id);
    if (!await taskRunExitMatches(tx, run.id, proof)) throw new Error(`Supplemental writable directory conflicts with TaskRun ${run.id}; writer exit is not proven`);
  }
}
