import { RuntimePreparationError } from '../task-graph/runtime-preflight';
import { realpath } from 'node:fs/promises';
import { prisma } from '../prisma';
import { directoryContains } from './model';

export class ResourceApplicationError extends RuntimePreparationError {
  constructor(detail: string, roots: string[]) {
    super('invalid', detail, roots);
    this.failure.code = 'resource_application_failed';
    this.failure.action = '核对最终挂载与写入失败证据，修复后通过原话题明确接续；不重复申请已有授权。';
  }
}

/** Check the final combined mounts, after upstream, dependencies and capabilities were added. */
export async function recordResourceMountPlan(taskRunId: string, participantId: string, requiredWrites: string[], readOnlyPaths: string[], writableRoots: string[]) {
  const canonical = (value: string) => realpath(value).catch(() => value);
  const read = await Promise.all(readOnlyPaths.map(canonical));
  const write = await Promise.all(writableRoots.map(canonical));
  for (const root of await Promise.all(requiredWrites.map(canonical))) {
    if (!write.some(writable => directoryContains(writable, root)) || read.some(readonly => directoryContains(readonly, root))) {
      throw new ResourceApplicationError(`批准目录在最终挂载中不可写：${root}`, [root]);
    }
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${taskRunId} FOR UPDATE`;
    const participant = await tx.taskRunParticipant.findUniqueOrThrow({ where: { id: participantId } });
    if (participant.taskRunId !== taskRunId) throw new Error('Resource mount participant changed');
    const metadata = JSON.parse(participant.controlMetadata || '{}');
    await tx.taskRunParticipant.update({ where: { id: participantId }, data: { controlMetadata: JSON.stringify({ ...metadata,
      resources: { ...metadata.resources, state: 'prepared', finalMounts: { readOnlyRoots: read, writableRoots: write } } }) } });
  });
}

export async function recordResourceSession(taskRunId: string, participantId: string, nativeSessionId: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${taskRunId} FOR UPDATE`;
    const participant = await tx.taskRunParticipant.findUniqueOrThrow({ where: { id: participantId } });
    if (participant.taskRunId !== taskRunId) throw new Error('Resource session participant changed');
    const metadata = JSON.parse(participant.controlMetadata || '{}');
    if (!metadata.resources?.finalMounts) throw new Error('资源最终挂载尚未核验');
    await tx.taskRunParticipant.update({ where: { id: participantId }, data: { controlMetadata: JSON.stringify({ ...metadata,
      resources: { ...metadata.resources, state: 'effective', nativeSessionId } }) } });
  });
}
