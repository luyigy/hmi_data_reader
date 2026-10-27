import { createHash } from 'node:crypto';
import os from 'node:os';
import type { TaskRun, TaskRunParticipant } from '@prisma/client';

type LegacyRun = Pick<TaskRun, 'id' | 'taskId' | 'taskSessionId' | 'status' | 'completedAt' | 'controlMetadata'> & {
  participants: Pick<TaskRunParticipant, 'id' | 'executionBackend' | 'harnessType' | 'status' | 'completedAt' | 'controlMetadata'>[];
};

export function legacyWriterFingerprint(run: LegacyRun): string {
  const metadata = JSON.parse(run.controlMetadata || '{}');
  delete metadata.legacyWriterRelease;
  return createHash('sha256').update(JSON.stringify({ id: run.id, taskId: run.taskId,
    taskSessionId: run.taskSessionId, status: run.status, completedAt: run.completedAt, metadata,
    participants: [...run.participants].sort((a, b) => a.id.localeCompare(b.id)).map(p => ({
      id: p.id, executionBackend: p.executionBackend, harnessType: p.harnessType,
      status: p.status, completedAt: p.completedAt, controlMetadata: p.controlMetadata,
    })),
  })).digest('hex');
}

/** Only the operator's verified service-drain migration issues this receipt. A terminal status is insufficient. */
export function hasLegacyWriterRelease(run: LegacyRun): boolean {
  try {
    const metadata: unknown = JSON.parse(run.controlMetadata || '{}');
    if (!metadata || typeof metadata !== 'object' || 'graphWriter' in metadata || !('legacyWriterRelease' in metadata)) return false;
    const release: unknown = metadata.legacyWriterRelease;
    if (!release || typeof release !== 'object') return false;
    const field = (name: string): unknown => Reflect.get(release, name);
    const releasedAt = field('releasedAt');
    const evidenceSha256 = field('evidenceSha256');
    return field('version') === 1 && field('kind') === 'service_drain'
      && field('hostname') === os.hostname() && field('uid') === process.getuid?.()
      && field('taskRunId') === run.id && field('identitySha256') === legacyWriterFingerprint(run)
      && typeof releasedAt === 'string' && Number.isFinite(Date.parse(releasedAt))
      && run.completedAt !== null && run.completedAt.getTime() <= Date.parse(releasedAt)
      && ['completed', 'failed', 'cancelled', 'interrupted', 'stopped'].includes(run.status)
      && run.participants.length > 0 && run.participants.every(p => p.executionBackend === 'platform_local')
      && typeof evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidenceSha256);
  } catch { return false; }
}
