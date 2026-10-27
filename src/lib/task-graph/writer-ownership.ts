import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { prisma } from '../prisma';
import { hasLegacyWriterRelease } from './legacy-writer-release';
import { hasIndependentProcessOrigin, readProcessIdentity as processIdentity, readProcessAncestry, parseProcessAncestry, type ProcessAncestor } from './process-lineage';

export type GraphWriter = {
  version: 1;
  nonce: string;
  hostname: string;
  uid: number;
  supervisor: { pid: number; startTime: string; bootId: string };
  ancestry?: ProcessAncestor[];
};

export type WriterObservation =
  | { kind: 'alive'; pids: number[] }
  | { kind: 'exited' }
  | { kind: 'unknown'; reason: string };

export async function createGraphWriter(): Promise<GraphWriter> {
  if (!process.getuid) throw new Error('Graph writer observation requires a local Linux process');
  const identity = await processIdentity(process.pid);
  const ancestry = await readProcessAncestry({ pid: process.pid, startTime: identity.startTime });
  return { version: 1, nonce: randomUUID(), hostname: os.hostname(), uid: process.getuid(), ancestry,
    supervisor: { pid: process.pid, startTime: identity.startTime,
      bootId: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() } };
}

export function parseGraphWriter(value: unknown): GraphWriter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version: unknown = Reflect.get(value, 'version');
  const nonce: unknown = Reflect.get(value, 'nonce');
  const hostname: unknown = Reflect.get(value, 'hostname');
  const uid: unknown = Reflect.get(value, 'uid');
  const supervisor: unknown = Reflect.get(value, 'supervisor');
  if (version !== 1 || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce) || typeof hostname !== 'string'
      || typeof uid !== 'number' || !Number.isInteger(uid) || !supervisor || typeof supervisor !== 'object') return null;
  const pid: unknown = Reflect.get(supervisor, 'pid');
  const startTime: unknown = Reflect.get(supervisor, 'startTime');
  const bootId: unknown = Reflect.get(supervisor, 'bootId');
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof startTime !== 'string'
      || !/^\d+$/.test(startTime) || typeof bootId !== 'string' || !bootId) return null;
  const ancestry: unknown = Reflect.get(value, 'ancestry');
  const parsed = ancestry === undefined ? undefined : parseProcessAncestry(ancestry, { pid, startTime });
  if (parsed === null) return null;
  return { version, nonce, hostname, uid, supervisor: { pid, startTime, bootId }, ...(parsed ? { ancestry: parsed } : {}) };
}

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
}

/** A lease timeout is not evidence that a process stopped. Inspect the local owner and its children. */
export async function observeGraphWriter(value: unknown, supervisorReleased = false): Promise<WriterObservation> {
  const writer = parseGraphWriter(value);
  if (!writer) return { kind: 'unknown', reason: 'No durable writer identity' };
  if (writer.hostname !== os.hostname() || writer.uid !== process.getuid?.()) return { kind: 'unknown', reason: 'Writer belongs to another host or user' };
  try {
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!supervisorReleased && bootId === writer.supervisor.bootId) {
      try {
        const owner = await processIdentity(writer.supervisor.pid);
        if (owner.startTime === writer.supervisor.startTime && !['Z', 'X'].includes(owner.state)) return { kind: 'alive', pids: [writer.supervisor.pid] };
      } catch (error) { if (!missing(error)) throw error; }
    }
    const pids: number[] = [];
    const marker = `AP_GRAPH_WRITER_NONCE=${writer.nonce}`;
    for (const entry of await fs.readdir('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        if ((await fs.stat(`/proc/${entry.name}`)).uid !== writer.uid) continue;
        const identity = await processIdentity(Number(entry.name));
        // A nonce is supplied only to newly spawned harnesses, never to a pre-existing server.
        if (BigInt(identity.startTime) < BigInt(writer.supervisor.startTime)) continue;
        const environment = await fs.readFile(`/proc/${entry.name}/environ`);
        if (environment.toString().split('\0').includes(marker)) {
          if (!['Z', 'X'].includes(identity.state)) pids.push(Number(entry.name));
        }
      } catch (error) {
        if (missing(error)) continue;
        if (error instanceof Error && 'code' in error && error.code === 'EACCES' &&
            await hasIndependentProcessOrigin({ pid: Number(entry.name), owner: writer.supervisor, ancestry: writer.ancestry })) continue;
        throw error;
      }
    }
    return pids.length ? { kind: 'alive', pids } : { kind: 'exited' };
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function graphWriterEnvironment(taskRunId: string): Promise<Record<string, string>> {
  const run = await prisma.taskRun.findUnique({ where: { id: taskRunId }, select: { controlMetadata: true } });
  if (!run?.controlMetadata) return {};
  const metadata: unknown = JSON.parse(run.controlMetadata);
  const writer = metadata && typeof metadata === 'object' ? parseGraphWriter(Reflect.get(metadata, 'graphWriter')) : null;
  return writer ? { AP_GRAPH_WRITER_NONCE: writer.nonce } : {};
}

export async function observeTaskRunWriter(taskRunId: string, db: Prisma.TransactionClient = prisma): Promise<WriterObservation> {
  const run = await db.taskRun.findUnique({ where: { id: taskRunId }, include: { participants: true } });
  if (run && hasLegacyWriterRelease(run)) return { kind: 'exited' };
  if (!run || !run.participants.length || run.participants.some(participant => participant.executionBackend !== 'platform_local' || !['codex', 'kimi-code'].includes(participant.harnessType || ''))) return { kind: 'unknown', reason: 'Writer backend has no local process proof' };
  try {
    const metadata: unknown = JSON.parse(run.controlMetadata || '{}');
    const writer = metadata && typeof metadata === 'object' ? parseGraphWriter(Reflect.get(metadata, 'graphWriter')) : null;
    const release: unknown = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'graphWriterReleased') : undefined;
    const released = Boolean(writer && release && typeof release === 'object' && Reflect.get(release, 'nonce') === writer.nonce && typeof Reflect.get(release, 'at') === 'string' && Number.isFinite(Date.parse(Reflect.get(release, 'at'))));
    return observeGraphWriter(writer, released);
  } catch (error) { return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }; }
}

/** Called by the runner only after participant and attempt-service cleanup have returned. */
export async function releaseTaskRunWriter(taskRunId: string, nonce: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${taskRunId} FOR UPDATE`;
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, select: { controlMetadata: true } });
    const metadata: unknown = JSON.parse(run.controlMetadata || '{}');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid TaskRun writer metadata');
    const writer = parseGraphWriter(Reflect.get(metadata, 'graphWriter'));
    const current = await createGraphWriter();
    if (!writer || writer.nonce !== nonce || writer.supervisor.pid !== current.supervisor.pid || writer.supervisor.startTime !== current.supervisor.startTime || writer.supervisor.bootId !== current.supervisor.bootId) throw new Error('TaskRun writer release ownership changed');
    await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...metadata, graphWriterReleased: { nonce, at: new Date().toISOString() } }) } });
  });
}
