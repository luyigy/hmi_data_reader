import type { Prisma } from '@prisma/client';
import { graphAssociationForTask } from './graph-association';

/** Member inheritance follows the same registered role Task used by room execution. */
export async function graphMemberPermissionTask(tx: Prisma.TransactionClient, member: {
  role: string; backend: string | null; harnessType: string | null; runtimeAgentId: string | null;
}, sourceTaskId: string | null) {
  const job = sourceTaskId ? await tx.taskGraphExecution.findUnique({ where: { childTaskId: sourceTaskId } }) : null;
  if (!job || member.role === 'implementer') return sourceTaskId ? tx.task.findUnique({ where: { id: sourceTaskId } }) : null;
  const participants = await tx.taskRunParticipant.findMany({ where: {
    role: member.role, harnessType: member.harnessType || undefined, executionBackend: member.backend || undefined,
    agentId: member.runtimeAgentId, taskRun: { AND: [{ controlMetadata: { contains: 'graphReview' } }, { controlMetadata: { contains: job.nodeId } }] },
  }, orderBy: { taskRun: { createdAt: 'desc' } }, include: { taskRun: true } });
  const tasks = new Set<string>();
  for (const participant of participants) {
    const association = await graphAssociationForTask(participant.taskRun.taskId, member.role, tx);
    if (association?.nodeId === job.nodeId) tasks.add(participant.taskRun.taskId);
  }
  if (tasks.size !== 1) return null;
  return tx.task.findUnique({ where: { id: Array.from(tasks)[0] } });
}
