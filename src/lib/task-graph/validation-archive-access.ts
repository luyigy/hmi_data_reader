import { existsSync } from 'node:fs';
import { prisma } from '../prisma';

/** Resolve archived reports only through the task's recorded execution and cleanup receipt. */
export async function graphValidationArchiveForTask(taskId: string) {
  const discussion = taskId.startsWith('task-graph-discussion-') ? taskId.slice('task-graph-discussion-'.length) : undefined;
  const execution = await prisma.taskGraphExecution.findFirst({ where: discussion ? { id: discussion } : { childTaskId: taskId }, select: { nodeId: true } });
  if (!execution) return null;
  const receipt = await prisma.taskGraphEvent.findFirst({ where: { nodeId: execution.nodeId, kind: 'validation_workspace_cleaned' }, orderBy: { createdAt: 'desc' } });
  const payload = receipt?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.directory === 'string' && typeof payload.manifest === 'string' && existsSync(payload.manifest)
    ? payload.directory : null;
}
