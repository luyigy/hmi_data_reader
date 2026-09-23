import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';

export type FeishuTaskScope = { appId: string; chatId: string };
type Conversation = FeishuTaskScope & {
  chatType: 'group' | 'p2p';
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
};

function required(value: string) {
  if (!value?.trim() || value !== value.trim()) throw new Error('Missing or invalid Feishu identity/configuration');
  return value;
}

function scopeKey(scope: FeishuTaskScope) {
  return { appId: required(scope.appId), chatId: required(scope.chatId) };
}

// Internal persistence API. The command layer must authorize the administrator.
export async function setFeishuTaskIsolation(scope: FeishuTaskScope, enabled: boolean, db = prisma) {
  const key = scopeKey(scope);
  return db.feishuGroupTaskSettings.upsert({
    where: { appId_chatId: key }, create: { ...key, isolationEnabled: enabled },
    update: { isolationEnabled: enabled },
  });
}

export async function isFeishuTaskIsolationEnabled(scope: FeishuTaskScope, db = prisma) {
  return (await db.feishuGroupTaskSettings.findUnique({
    where: { appId_chatId: scopeKey(scope) },
  }))?.isolationEnabled ?? false;
}

// Shared with feishu-task-broadcast: the settings row lock serializes every
// isolation-mode mutation, task confirmation and broadcast publish per group.
export async function lockEnabledGroup(tx: Prisma.TransactionClient, scope: FeishuTaskScope) {
  const rows = await tx.$queryRaw<{ isolationEnabled: boolean }[]>`
    SELECT "isolationEnabled" FROM "FeishuGroupTaskSettings"
    WHERE "appId" = ${scope.appId} AND "chatId" = ${scope.chatId} FOR UPDATE
  `;
  if (!rows[0]?.isolationEnabled) throw new Error('Task isolation is disabled');
}

// Persist BEFORE sending the entry card. Use request.id as the send API uuid.
// Failed/ambiguous sends retain this intent; retry/reconcile the same card, never
// create a room or send a fresh card blindly. No external call runs in a DB transaction.
export async function reserveFeishuTaskBinding(
  args: FeishuTaskScope & { sourceMessageId: string; title: string; workingDirectory: string },
  db = prisma,
) {
  const key = { ...scopeKey(args), sourceMessageId: required(args.sourceMessageId) };
  required(args.title);
  required(args.workingDirectory);
  return db.$transaction(async (tx) => {
    await lockEnabledGroup(tx, key);
    const existing = await tx.feishuTaskBindingRequest.findUnique({ where: { appId_chatId_sourceMessageId: key } });
    if (existing) {
      if (existing.title !== args.title || existing.workingDirectory !== args.workingDirectory) {
        throw new Error('Task creation request conflicts with the original request');
      }
      return existing;
    }
    return tx.feishuTaskBindingRequest.create({ data: { ...key, title: args.title, workingDirectory: args.workingDirectory } });
  });
}

// The root comes from the successful entry-card send, not an inbound parent_id.
export async function recordFeishuTaskRoot(
  scope: FeishuTaskScope, requestId: string, rootMessageId: string, db = prisma,
) {
  const key = scopeKey(scope);
  required(requestId);
  required(rootMessageId);
  const result = await db.feishuTaskBindingRequest.updateMany({
    where: { id: requestId, ...key, OR: [{ rootMessageId: null }, { rootMessageId }] },
    data: { rootMessageId },
  });
  if (result.count !== 1) throw new Error('Unknown task request or conflicting root message');
}

// Only call with a trusted Feishu API response (reply/get) or verified event.
// SDK contract: thread_id is distinct from root_id and parent_id; no conversion.
export async function confirmFeishuTaskBinding(
  scope: FeishuTaskScope,
  requestId: string,
  message: { chatId: string; threadId: string; rootMessageId: string },
  db = prisma,
) {
  const key = scopeKey(scope);
  required(requestId);
  required(message.threadId);
  required(message.rootMessageId);
  if (message.chatId !== key.chatId) throw new Error('Cross-chat task binding rejected');
  return db.$transaction(async (tx) => {
    // Serialize confirmation and mode changes, including repeated confirmations.
    await tx.$queryRaw`SELECT "appId" FROM "FeishuGroupTaskSettings"
      WHERE "appId" = ${key.appId} AND "chatId" = ${key.chatId} FOR UPDATE`;
    const request = await tx.feishuTaskBindingRequest.findFirst({ where: { id: requestId, ...key } });
    if (!request || request.rootMessageId !== message.rootMessageId) throw new Error('Unverified task root');
    if (request.bindingId) {
      const binding = await tx.feishuConversationBinding.findUniqueOrThrow({ where: { id: request.bindingId } });
      if (binding.threadId !== message.threadId) throw new Error('Conflicting task thread');
      return binding;
    }
    await lockEnabledGroup(tx, key);
    // Nested creation is atomic: a uniqueness conflict rolls back the room too.
    // Members/history are deliberately not copied from the group room.
    const binding = await tx.feishuConversationBinding.create({
      data: {
        ...key, chatType: 'group', threadId: message.threadId, rootMessageId: message.rootMessageId,
        scopeKey: `feishu:task:${JSON.stringify([key.appId, key.chatId, message.threadId])}`,
        liveRoom: { create: {
          title: request.title, workingDirectory: request.workingDirectory,
          createdBy: 'feishu', mode: 'discussion', status: 'active',
        } },
      },
    });
    await tx.feishuTaskBindingRequest.update({ where: { id: requestId }, data: { bindingId: binding.id } });
    return binding;
  });
}

// S02 routes every input/control through this resolver before any legacy fallback.
export async function resolveFeishuTaskConversation(context: Conversation, db: PrismaClient = prisma) {
  const key = scopeKey(context);
  for (const value of [context.threadId, context.rootMessageId, context.parentMessageId]) {
    if (value !== undefined) required(value);
  }
  const hasTopic = !!(context.threadId || context.rootMessageId || context.parentMessageId);
  if (context.chatType === 'group' && hasTopic) {
    const binding = context.threadId
      ? await db.feishuConversationBinding.findUnique({ where: { appId_chatId_threadId: { ...key, threadId: context.threadId } } })
      : await db.feishuConversationBinding.findUnique({ where: { appId_chatId_rootMessageId: {
          ...key, rootMessageId: context.rootMessageId || context.parentMessageId!,
        } } });
    // A parent can locate a task only if it is a persisted entry root. It is
    // never treated as a thread ID. Explicit unknown threads never fall back.
    if (!binding || (context.rootMessageId && context.rootMessageId !== binding.rootMessageId)) {
      return { kind: 'unknown_topic' as const };
    }
    if (context.parentMessageId) {
      const parentBinding = await db.feishuConversationBinding.findUnique({ where: {
        appId_chatId_rootMessageId: { ...key, rootMessageId: context.parentMessageId },
      } });
      if (parentBinding && parentBinding.id !== binding.id) return { kind: 'unknown_topic' as const };
    }
    const room = await db.liveRoom.findUniqueOrThrow({ where: { id: binding.liveRoomId }, select: { status: true } });
    return { kind: room.status === 'archived' ? 'archived_task' as const : 'task' as const, binding };
  }
  // The existing runtime has one FEISHU_APP_ID. Legacy rows have no app identity;
  // never let another app adopt them. New task bindings always have explicit appId.
  const binding = key.appId === process.env.FEISHU_APP_ID
    ? await db.feishuConversationBinding.findUnique({ where: {
        scopeKey: `feishu:${context.chatType === 'p2p' ? 'p2p' : 'group'}:${key.chatId}`,
      } })
    : null;
  return { kind: 'group_entry' as const, binding };
}
