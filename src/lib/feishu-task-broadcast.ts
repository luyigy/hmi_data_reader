import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { lockEnabledGroup, type FeishuTaskScope } from './feishu-task-binding';

export type { FeishuTaskScope };

type BroadcastRecord = Prisma.FeishuGroupBroadcastGetPayload<{ include: { targets: true } }>;

function required(value: string) {
  if (!value?.trim() || value !== value.trim()) throw new Error('Missing or invalid Feishu broadcast identity');
  return value;
}

function scopeKey(scope: FeishuTaskScope) {
  return { appId: required(scope.appId), chatId: required(scope.chatId) };
}

export type PublishFeishuGroupBroadcastArgs = FeishuTaskScope & {
  /** Inbound message id that carried the broadcast text; replay-safe dedup key. */
  sourceMessageId: string;
  /** Feishu open_id of the authorized sender; kept for audits, never used for routing. */
  senderOpenId: string;
  /** Original public text, stored verbatim (not trimmed content normalization). */
  content: string;
};

// Publish one group-scoped public notification. Internal persistence API: the
// command layer (467 S03) must authorize the sender and the group mode.
// Semantics (PLAN 467 S01):
// - mode off (or never enabled) rejects NEW publishes; stored records stay readable;
// - one row per source message: replays return the original record;
// - the target set is fixed inside the transaction from currently-active task
//   bindings of the SAME app+chat and snapshotted immutably; archived tasks and
//   tasks created later are excluded, other groups/apps never leak in;
// - sequence is gap-free per group because every publish takes the same
//   FeishuGroupTaskSettings row lock as isolation toggles and task confirmation.
export async function publishFeishuGroupBroadcast(
  args: PublishFeishuGroupBroadcastArgs,
  db: PrismaClient = prisma,
): Promise<{ created: boolean; broadcast: BroadcastRecord }> {
  const key = scopeKey(args);
  const sourceMessageId = required(args.sourceMessageId);
  const senderOpenId = required(args.senderOpenId);
  if (!args.content?.trim()) throw new Error('Missing or invalid Feishu broadcast identity');
  return db.$transaction(async (tx) => {
    await lockEnabledGroup(tx, key);
    const existing = await tx.feishuGroupBroadcast.findUnique({
      where: { appId_chatId_sourceMessageId: { ...key, sourceMessageId } },
      include: { targets: true },
    });
    if (existing) {
      // Same source message replays must not rewrite history.
      if (existing.senderOpenId !== senderOpenId || existing.content !== args.content) {
        throw new Error('Broadcast conflicts with the original record');
      }
      return { created: false, broadcast: existing };
    }
    const last = await tx.feishuGroupBroadcast.findFirst({
      where: key, orderBy: { sequence: 'desc' }, select: { sequence: true },
    });
    const activeTasks = await tx.feishuConversationBinding.findMany({
      where: {
        ...key,
        threadId: { not: null },
        rootMessageId: { not: null },
        liveRoom: { status: 'active' },
      },
      select: { id: true, liveRoomId: true, threadId: true, rootMessageId: true },
    });
    const broadcast = await tx.feishuGroupBroadcast.create({
      data: {
        ...key,
        sequence: (last?.sequence ?? 0) + 1,
        sourceMessageId,
        senderOpenId,
        content: args.content,
        targets: {
          create: activeTasks.map((binding) => ({
            ...key,
            bindingId: binding.id,
            liveRoomId: binding.liveRoomId,
            threadId: binding.threadId!,
            rootMessageId: binding.rootMessageId!,
          })),
        },
      },
      include: { targets: true },
    });
    return { created: true, broadcast };
  });
}

// Ordered read access for later slices and audits; unchanged by mode toggles.
export async function listFeishuGroupBroadcasts(scope: FeishuTaskScope, db: PrismaClient = prisma) {
  return db.feishuGroupBroadcast.findMany({
    where: scopeKey(scope),
    orderBy: [{ sequence: 'asc' }],
    include: { targets: { orderBy: { bindingId: 'asc' } } },
  });
}
