import { prisma } from '@/lib/prisma';
import {
  removeTypingReaction,
  sendFeishuInteractiveMessage,
  sendFeishuTextMessage,
} from '@/lib/feishu-api';
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

export const selectFeishuRelayBinding = (
  bindings: FeishuConversationBindingRow[],
  message: LiveRoomMessagePayload
) => {
  const bindingId = typeof message.metadata?.feishuBindingId === 'string'
    ? message.metadata.feishuBindingId
    : null;
  const chatId = typeof message.metadata?.feishuChatId === 'string'
    ? message.metadata.feishuChatId
    : null;

  return bindings.find((binding) => binding.id === bindingId)
    || bindings.find((binding) => binding.chatId === chatId)
    || (bindings.length === 1 ? bindings[0] : null);
};

export const shouldRelayLiveRoomMessage = (message: LiveRoomMessagePayload) => {
  if (message.messageType === 'assistant') {
    return true;
  }

  if (message.messageType === 'system') {
    if (!message.content.startsWith('系统提示：')) {
      return false;
    }

    if (message.metadata?.systemEvent !== 'member_reply_progress') {
      return true;
    }

    return message.metadata.progressKind === 'heartbeat';
  }

  return false;
};

export const buildAssistantRelayCard = (message: LiveRoomMessagePayload) => {
  const targetMemberName =
    typeof message.metadata?.targetMemberName === 'string'
      ? message.metadata.targetMemberName
      : null;
  const deliveryIntent = message.metadata?.deliveryIntent;
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: message.content },
  ];

  if (deliveryIntent === 'handoff' && targetMemberName) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `下一位：${targetMemberName}` }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: deliveryIntent === 'directed_visible' && targetMemberName
          ? `${message.senderName} → ${targetMemberName}`
          : message.senderName,
      },
    },
    elements,
  };
};

export async function relayLiveRoomMessageToFeishu(message: LiveRoomMessagePayload) {
  if (!shouldRelayLiveRoomMessage(message)) {
    return;
  }

  const bindings = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
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
  `;
  const binding = selectFeishuRelayBinding(bindings, message);

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

  if (message.messageType === 'assistant') {
    await sendFeishuInteractiveMessage({
      receiveId: binding.chatId,
      receiveIdType: 'chat_id',
      card: buildAssistantRelayCard(message),
    });
  } else {
    await sendFeishuTextMessage({
      receiveId: binding.chatId,
      receiveIdType: 'chat_id',
      text: message.content,
    });
  }
}
