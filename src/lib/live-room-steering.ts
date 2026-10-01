import { prisma } from '@/lib/prisma';
import { postLiveRoomMessage, resolveLiveRoomMessageMetadata } from '@/lib/live-room';
import { getLiveRoomSteering, steerLiveRoomMember } from '@/lib/live-room-process-registry';

// Same process ownership as the Live Room execution queue; DB deliveries retain
// deduplication after restart. Unknown receipts are deliberately never replayed.
const registry = globalThis as unknown as { piRoomDispatches?: Map<string, Promise<void>> };
export async function dispatchLocalSteeringOnce(messageId: string, memberId: string, dispatch: () => Promise<void>) {
  const store = registry.piRoomDispatches ??= new Map();
  const key = `${memberId}:${messageId}`;
  const previous = store.get(key);
  if (previous) return previous;
  const operation = (async () => {
    const existing = await prisma.liveRoomDelivery.findFirst({ where: { roomMessageId: messageId, targetMemberId: memberId } });
    if (!existing) await dispatch();
  })();
  store.set(key, operation);
  try { await operation; } finally { if (store.get(key) === operation) store.delete(key); }
}

export async function trySteerLocalMember(args: {
  deliveryId: string; roomId: string; sessionId: string; memberId: string;
  messageId: string; content: string; displayName: string; generation: number; createdAt: Date;
  relayOrigin: { feishuBindingId?: string; feishuChatId?: string };
  harnessType?: string | null;
}): Promise<boolean> {
  const running = getLiveRoomSteering(args.memberId);
  if (!running) return false;
  const olderQueued = await prisma.liveRoomDelivery.findFirst({
    where: { targetMemberId: args.memberId, deliveryStatus: 'pending', id: { not: args.deliveryId },
      createdAt: { lte: args.createdAt } },
  });
  if (olderQueued) return false; // Do not overtake messages queued during startup.
  // Persist the claim BEFORE writing stdin. A lost receipt must not cause replay.
  const claim = await prisma.liveRoomDelivery.updateMany({
    where: { id: args.deliveryId, deliveryStatus: 'pending' },
    data: { deliveryStatus: 'running', attemptedAt: new Date(), fallbackReason: 'Local steering receipt pending' },
  });
  if (!claim.count) return true;
  let result: 'accepted' | 'rejected' | 'unknown';
  try {
    result = await steerLiveRoomMember(args.memberId, args.roomId, args.sessionId, args.messageId,
      `Additional user instruction (message ${args.messageId}):\n${args.content}`, args.generation, running.runMessageId);
  } catch { result = 'unknown'; }
  const recorded = await prisma.liveRoomDelivery.updateMany({
    where: { id: args.deliveryId, deliveryStatus: 'running' },
    data: {
      deliveryStatus: result === 'rejected' ? 'pending' : result === 'accepted' ? 'delivered' : 'failed',
      acknowledgedAt: result === 'rejected' ? null : new Date(),
      fallbackReason: result === 'accepted' ? `Local steering accepted; runMessageId=${running.runMessageId}; generation=${args.generation}`
        : result === 'unknown' ? `Local steering receipt unknown; runMessageId=${running.runMessageId}; not automatically replayed` : null,
    },
  });
  if (!recorded.count) return true; // A stop/reset already cancelled this delivery.
  if (result === 'rejected') return false;
  await postLiveRoomMessage({
    roomId: args.roomId, messageType: 'system',
    content: result === 'accepted'
      ? args.harnessType === 'antigravity'
        ? `系统提示：${args.displayName} 已接收追加指令，正在中断当前轮并在同一会话继续处理新指令；接收不代表已完成。`
        : `系统提示：${args.displayName} 已接收追加指令，将在当前运行后续可处理输入的模型调用中处理；接收不代表已完成。`
      : `系统提示：${args.displayName} 的追加指令接收状态不明，为避免重复执行未自动重发，请核对后再决定是否重发。`,
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system', targetMemberId: args.memberId,
      extras: { ...args.relayOrigin, deliveryId: args.deliveryId,
        systemEvent: result === 'accepted' ? 'member_reply_steered' : 'member_reply_steering_unknown' },
    }),
  });
  return true;
}
