import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { redactSensitiveText } from '../redact-sensitive';

type GraphNotification =
  | { kind: 'child_topic'; parentTaskId: string; executionId: string; childTaskId: string; title: string; workingDirectory: string }
  | { kind: 'child_progress'; childTaskId: string; eventKey: string; text: string }
  | { kind: 'human_review'; nodeKey: string };

function parseNotification(value: unknown): GraphNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph notification');
  const field = (key: string) => {
    const item: unknown = Reflect.get(value, key);
    if (typeof item !== 'string' || !item) throw new Error(`Invalid graph notification ${key}`);
    return item;
  };
  switch (field('kind')) {
    case 'child_topic': return { kind: 'child_topic', parentTaskId: field('parentTaskId'), executionId: field('executionId'), childTaskId: field('childTaskId'), title: field('title'), workingDirectory: field('workingDirectory') };
    case 'child_progress': return { kind: 'child_progress', childTaskId: field('childTaskId'), eventKey: field('eventKey'), text: field('text') };
    case 'human_review': return { kind: 'human_review', nodeKey: field('nodeKey') };
    default: throw new Error('Unknown graph notification kind');
  }
}

export async function queueGraphNotification(runId: string, identity: string, notification: GraphNotification) {
  const idempotencyKey = `notification:${createHash('sha256').update(identity).digest('hex')}`;
  return prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey } }, update: {},
    create: { runId, idempotencyKey, kind: 'notification_requested', payload: notification } });
}

export async function requestGraphChildTopic(args: Omit<Extract<GraphNotification, { kind: 'child_topic' }>, 'kind'>) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId }, select: { node: { select: { runId: true } } } });
  await queueGraphNotification(job.node.runId, `child-topic:${args.executionId}`, { kind: 'child_topic', ...args });
}

export async function deliverGraphNotificationOnce(args: { runId: string; identity: string; send: () => Promise<string | null | undefined> }) {
  const identity = createHash('sha256').update(args.identity).digest('hex');
  const key = { runId: args.runId, idempotencyKey: `notification-message:${identity}` };
  const receipt = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: key } });
  if (receipt) {
    const messageId: unknown = receipt.payload && typeof receipt.payload === 'object' ? Reflect.get(receipt.payload, 'messageId') : null;
    if (typeof messageId !== 'string') throw new Error('Notification message receipt needs reconciliation');
    return messageId;
  }
  const attemptKey = { runId: args.runId, idempotencyKey: `notification-send:${identity}` };
  const attempt = await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: attemptKey }, update: {},
    create: { ...attemptKey, kind: 'notification_send_started', payload: { identity: args.identity } } });
  if (Date.now() - attempt.createdAt.getTime() > 50 * 60_000) throw new Error('Notification send uncertain; reconcile the original request before resending');
  const messageId = await args.send();
  if (!messageId) throw new Error('Notification send returned no message id');
  await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: key }, update: {},
    create: { ...key, kind: 'notification_message_sent', payload: { messageId } } });
  return messageId;
}

export async function relayGraphNotifications() {
  const pending = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM "TaskGraphEvent" e
    WHERE e.kind = 'notification_requested'
      AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" r WHERE r."runId" = e."runId" AND r."idempotencyKey" = 'notification-delivered:' || e.id)
      AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" r WHERE r."runId" = e."runId" AND r.kind = 'notification_failed'
        AND r.payload->>'notificationId' = e.id AND r."createdAt" > NOW() - INTERVAL '30 seconds')
    ORDER BY e."createdAt" LIMIT 100`;
  for (const { id } of pending) {
    try {
      await prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-notification:${id}`})) AS locked`;
        if (!lock.locked) return;
        const event = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id } });
        const receiptKey = { runId: event.runId, idempotencyKey: `notification-delivered:${id}` };
        if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: receiptKey } })) return;
        const notification = parseNotification(event.payload);
        const feishu = await import('./feishu');
        switch (notification.kind) {
          case 'child_topic': {
            if (!await feishu.ensureGraphChildTopic(notification)) throw new Error('Repository group is not registered; notification remains pending');
            break;
          }
          case 'child_progress': {
            const sent = await feishu.deliverGraphChildProgress(notification.childTaskId, notification.eventKey, notification.text);
            if (!sent) throw new Error('Child topic not yet available');
            break;
          }
          case 'human_review': await feishu.deliverGraphHumanReviewCard(event.runId, notification.nodeKey); break;
        }
        await tx.taskGraphEvent.create({ data: { ...receiptKey, kind: 'notification_delivered', payload: { notificationId: id } } });
      }, { timeout: 60_000 });
    } catch (error) {
      const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id } });
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      const idempotencyKey = `notification-failed:${id}:${Math.floor(Date.now() / 30_000)}`;
      await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: event.runId, idempotencyKey } },
        create: { runId: event.runId, idempotencyKey, kind: 'notification_failed', payload: { notificationId: id, detail } }, update: {} });
      console.error('[TaskGraphNotifications] delivery pending', { notificationId: id, detail });
    }
  }
}
