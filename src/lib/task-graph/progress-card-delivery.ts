import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { deliverGraphNotificationOnce } from './notifications';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Both callers hold the binding advisory lock; durable send intent survives response loss. */
export async function deliverProgressCard(args: {
  bindingId: string; runId?: string; childTaskId?: string; chatId: string; rootMessageId: string | null;
  card: Parameters<typeof sendFeishuInteractiveMessage>[0]['card']; messageId?: string | null;
  firstRun?: { taskRunId: string; createdAt: Date };
  taskRunId?: string; replyIdentity?: string;
}) {
  if (args.messageId) {
    await updateFeishuTaskEntryCard(args.messageId, args.card);
    return args.messageId;
  }
  const identity = `progress-card:${args.bindingId}${args.replyIdentity ? ':' + args.replyIdentity : args.taskRunId ? ':' + args.taskRunId : ''}`;
  const send = (uuid: string) => sendFeishuInteractiveMessage({ receiveId: args.chatId, card: args.card,
    ...(args.rootMessageId ? { threadRootMessageId: args.rootMessageId } : {}), uuid });
  const legacyUuid = args.taskRunId ? hash(identity).slice(0, 48) : args.firstRun && hash(`graph-reply:${args.firstRun.taskRunId}:${args.bindingId}`).slice(0, 48);
  if (!args.runId) {
    if (!args.firstRun || Date.now() - args.firstRun.createdAt.getTime() > 50 * 60_000) throw new Error('Reply receipt uncertain; reconcile before resending');
    return send(legacyUuid!);
  }
  const runId = args.runId;
  const receiptKey = { runId, idempotencyKey: `notification-message:${hash(identity)}` };
  let receipt = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: receiptKey } });
  let legacySend: { uuid: string; createdAt: Date } | undefined;
  if (!receipt && args.childTaskId && !args.taskRunId) {
    const legacyRequests = await prisma.taskGraphEvent.findMany({ where: { runId, kind: 'notification_requested',
      payload: { path: ['childTaskId'], equals: args.childTaskId } }, orderBy: { createdAt: 'asc' } });
    for (const request of legacyRequests) {
      const payload = request.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.kind !== 'child_progress' || typeof payload.eventKey !== 'string') continue;
      const legacyIdentity = `child-progress:${args.childTaskId}:${payload.eventKey}`;
      const legacy = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: `notification-message:${hash(legacyIdentity)}` } } });
      if (legacy) {
        receipt = await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: receiptKey }, update: {},
          create: { ...receiptKey, kind: 'notification_message_sent', payload: legacy.payload || {} } });
        break;
      }
      const attempted = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId,
        idempotencyKey: `notification-send:${hash(legacyIdentity)}` } } });
      if (attempted && !legacySend) legacySend = { createdAt: attempted.createdAt,
        uuid: `graph-child-${hash(`${args.childTaskId}:${payload.eventKey}`).slice(0, 32)}` };
    }
  }
  if (receipt) {
    const messageId = receipt.payload && typeof receipt.payload === 'object' && !Array.isArray(receipt.payload) ? receipt.payload.messageId : null;
    if (typeof messageId !== 'string') throw new Error('Progress card receipt needs reconciliation');
    await updateFeishuTaskEntryCard(messageId, args.card);
    return messageId;
  }
  const attemptKey = { runId, idempotencyKey: `notification-send:${hash(identity)}` };
  const attempt = await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: attemptKey }, update: {},
    create: { ...attemptKey, kind: 'notification_send_started', createdAt: legacySend?.createdAt || (args.taskRunId ? undefined : args.firstRun?.createdAt),
      payload: { identity, uuid: legacySend?.uuid || legacyUuid || hash(identity).slice(0, 48) } } });
  const uuid = attempt.payload && typeof attempt.payload === 'object' && !Array.isArray(attempt.payload) ? attempt.payload.uuid : null;
  if (typeof uuid !== 'string') throw new Error('Progress card send identity needs reconciliation');
  return deliverGraphNotificationOnce({ runId, identity, send: () => send(uuid) });
}
