/**
 * feishu-relay.ts
 *
 * Thin relay layer: sends live-room agent replies back to the bound Feishu chat.
 * Intentionally has NO import from live-room-delivery.ts to avoid circular deps.
 */
import { prisma } from '@/lib/prisma';
import { sendFeishuTextMessage } from '@/lib/feishu-api';

type FeishuConversationBindingRow = {
  id: string;
  chatId: string;
};

/**
 * After an agent posts a reply in a live room, call this to forward the
 * message back to the Feishu chat that is bound to the room (if any).
 */
export async function relayAgentReplyToFeishu(args: {
  roomId: string;
  agentDisplayName: string;
  content: string;
}): Promise<void> {
  const bindingRows = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT "id", "chatId"
    FROM "FeishuConversationBinding"
    WHERE "liveRoomId" = ${args.roomId}
    LIMIT 1
  `;
  const binding = bindingRows[0] || null;
  if (!binding) {
    return;
  }

  const text = `【${args.agentDisplayName}】\n${args.content}`;
  await sendFeishuTextMessage({
    receiveId: binding.chatId,
    receiveIdType: 'chat_id',
    text,
  });
}