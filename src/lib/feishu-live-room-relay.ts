import { prisma } from '@/lib/prisma';
import { sendFeishuTextMessage } from '@/lib/feishu-api';
import type { LiveRoomMessagePayload } from '@/lib/live-room';

type FeishuConversationBindingRow = {
  id: string;
  chatId: string;
  chatType: string;
  latestMessageId: string | null;
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
      "liveRoomId"
    FROM "FeishuConversationBinding"
    WHERE "liveRoomId" = ${message.roomId}
    LIMIT 1
  `;
  const binding = bindingRows[0] || null;

  if (!binding) {
    return;
  }

  await sendFeishuTextMessage({
    receiveId: binding.chatId,
    receiveIdType: 'chat_id',
    text: formatRelayText(message),
  });
}
