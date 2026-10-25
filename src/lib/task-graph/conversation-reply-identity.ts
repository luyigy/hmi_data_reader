import { createHash } from 'node:crypto';
import type { Prisma, TaskRun } from '@prisma/client';

/** Persist identity with input binding, before any native startup or card delivery. */
export async function bindConversationReplyIdentity(tx: Prisma.TransactionClient, taskRunId: string, rootInputIds: string[]) {
  if (!rootInputIds.length) return;
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const metadata = JSON.parse(run.controlMetadata || '{}');
  if (!metadata.graphConversation) return;
  const identity = 'conversation:' + createHash('sha256').update(JSON.stringify({
    inputs: Array.from(new Set(rootInputIds)).sort(), taskId: run.taskId, sessionId: run.taskSessionId,
    participants: run.participants.map(p => [p.role, p.executionBackend, p.harnessType, p.gatewayId, p.agentId]).sort(),
  })).digest('hex');
  if (metadata.graphReplyIdentity && metadata.graphReplyIdentity !== identity) throw new Error('Conversation reply identity already bound');
  await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...metadata, graphReplyIdentity: identity }) } });
}

/** Caller holds the topic lock. Only the newest attempt can publish a shared turn card. */
export async function conversationReplyOwner(tx: Prisma.TransactionClient, run: TaskRun, bindingId: string) {
  const identity = JSON.parse(run.controlMetadata || '{}').graphReplyIdentity;
  if (typeof identity !== 'string' || !/^conversation:[a-f0-9]{64}$/.test(identity)) return null;
  const attempts = await tx.taskRun.findMany({ where: { taskId: run.taskId, taskSessionId: run.taskSessionId,
    controlMetadata: { contains: JSON.stringify({ graphReplyIdentity: identity }).slice(1, -1) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  const receipt = await tx.taskRunFeishuRelay.findFirst({ where: { bindingId, taskRunId: { in: attempts.map(attempt => attempt.id) }, messageId: { not: null } },
    orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }] });
  return { identity, messageId: receipt?.messageId, superseded: attempts[0]?.id !== run.id };
}
