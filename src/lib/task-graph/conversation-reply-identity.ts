import { createHash } from 'node:crypto';
import type { Prisma, TaskRun } from '@prisma/client';

export const conversationReplyIdentity = (executionId: string, rootInputId: string) =>
  'conversation:' + createHash('sha256').update(JSON.stringify([executionId, rootInputId])).digest('hex');

export async function bindPhaseReplyIdentity(tx: Prisma.TransactionClient, taskRunId: string, phase: unknown) {
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const metadata = JSON.parse(run.controlMetadata || '{}');
  const identity = 'phase:' + createHash('sha256').update(JSON.stringify({ phase, task: run.taskId, session: run.taskSessionId,
    participants: run.participants.map(p => [p.role, p.executionBackend, p.harnessType, p.gatewayId, p.agentId]).sort() })).digest('hex');
  await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...metadata, graphReplyIdentity: identity }) } });
}

/** Caller holds the topic lock. Only the newest attempt can publish a shared turn card. */
export async function conversationReplyOwner(tx: Prisma.TransactionClient, run: TaskRun, bindingId: string) {
  const identity = JSON.parse(run.controlMetadata || '{}').graphReplyIdentity;
  if (typeof identity !== 'string' || !/^(?:conversation|phase):[a-f0-9]{64}$/.test(identity)) return null;
  const attempts = await tx.taskRun.findMany({ where: { taskId: run.taskId, taskSessionId: run.taskSessionId,
    controlMetadata: { contains: JSON.stringify({ graphReplyIdentity: identity }).slice(1, -1) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  const receipt = await tx.taskRunFeishuRelay.findFirst({ where: { bindingId, taskRunId: { in: attempts.map(attempt => attempt.id) }, messageId: { not: null } },
    orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }] });
  return { identity, messageId: receipt?.messageId, superseded: attempts[0]?.id !== run.id };
}
