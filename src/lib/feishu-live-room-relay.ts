import { prisma } from '@/lib/prisma';
import { removeTypingReaction, sendFeishuTextMessage } from '@/lib/feishu-api';
import type { LiveRoomMessagePayload } from '@/lib/live-room';

type FeishuConversationBindingRow = {
  id: string;
  chatId: string;
  chatType: string;
  latestMessageId: string | null;
  typingReactionId: string | null;
  typingForMessageId: string | null;
  liveRoomId: string;
};

const shouldRelayLiveRoomMessage = (message: LiveRoomMessagePayload) => {
  if (message.messageType === 'assistant') {
    return true;
  }

  if (message.messageType === 'system') {
    return message.content.startsWith('系统提示：');
  }

  return false;
};

const formatRelayText = (message: LiveRoomMessagePayload) => {
  if (message.messageType === 'assistant') {
    return `${message.senderName}:\n${message.content}`;
  }

  return message.content;
};

export async function relayLiveRoomMessageToFeishu(message: LiveRoomMessagePayload) {
  if (!shouldRelayLiveRoomMessage(message)) {
    return;
  }

  const bindingRows = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT
      "id",
      "chatId",
      "chatType",
      "latestMessageId",
      "typingReactionId",
      "typingForMessageId",
      "liveRoomId"
    FROM "FeishuConversationBinding"
    WHERE "liveRoomId" = ${message.roomId}
    LIMIT 1
  `;
  const binding = bindingRows[0] || null;

  if (!binding) {
    return;
  }

  // Remove typing reaction before sending the actual reply
  if (binding.typingReactionId && binding.typingForMessageId) {
    await removeTypingReaction(binding.typingForMessageId, binding.typingReactionId);
    await prisma.$executeRaw`
      UPDATE "FeishuConversationBinding"
      SET "typingReactionId" = NULL, "typingForMessageId" = NULL
      WHERE "id" = ${binding.id}
    `;
  }

  await sendFeishuTextMessage({
    receiveId: binding.chatId,
    receiveIdType: 'chat_id',
    text: formatRelayText(message),
  });
}
