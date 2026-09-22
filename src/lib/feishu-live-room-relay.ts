import path from 'node:path';
import { prisma } from '@/lib/prisma';
import {
  removeTypingReaction,
  sendFeishuInteractiveMessage,
  sendFeishuLocalImageMessage,
  sendFeishuTextMessage,
} from '@/lib/feishu-api';
import type { LiveRoomMessagePayload } from '@/lib/live-room';

type FeishuConversationBindingRow = {
  id: string;
  appId?: string | null;
  chatId: string;
  chatType: string;
  threadId?: string | null;
  rootMessageId?: string | null;
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

/** Task-thread bindings must deliver inside their topic: use the SDK-verified
 *  thread_id receive type. Failures never degrade to a group chat broadcast. */
export const resolveFeishuRelaySendTarget = (binding: FeishuConversationBindingRow) =>
  binding.threadId
    ? { receiveId: binding.threadId, receiveIdType: 'thread_id' as const, threadScoped: true }
    : { receiveId: binding.chatId, receiveIdType: 'chat_id' as const, threadScoped: false };

export const shouldRelayLiveRoomMessage = (message: LiveRoomMessagePayload) => {
  // Suppress relay when an interactive Feishu progress card is handling the same events
  if (message.metadata?.skipFeishuRelay) {
    return false;
  }

  if (message.messageType === 'assistant') {
    return true;
  }

  if (message.messageType === 'system') {
    if (!message.content.startsWith('系统提示：')) {
      return false;
    }

    const systemEvent = message.metadata?.systemEvent;
    if (systemEvent === 'member_reply_thinking' || systemEvent === 'member_reply_tool') {
      return false;
    }

    if (systemEvent !== 'member_reply_progress') {
      return true;
    }

    return message.metadata?.progressKind === 'heartbeat';
  }

  return false;
};

export const buildAssistantRelayCard = (
  message: LiveRoomMessagePayload,
  chatType: 'p2p' | 'group' = 'group',
) => {
  const targetMemberName =
    typeof message.metadata?.targetMemberName === 'string'
      ? message.metadata.targetMemberName
      : null;
  const deliveryIntent = message.metadata?.deliveryIntent;
  const executionRole = typeof message.metadata?.executionRole === 'string'
    ? message.metadata.executionRole
    : null;
  const elements: Array<Record<string, unknown>> = [
    ...(executionRole ? [{
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `执行角色：${executionRole}` }],
    }] : []),
    { tag: 'markdown', content: message.content },
  ];

  if (deliveryIntent === 'handoff' && targetMemberName) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `下一位：${targetMemberName}` }],
    });
  }

  const handoffRootMessageId = typeof message.metadata?.handoffRootMessageId === 'string'
    ? message.metadata.handoffRootMessageId
    : null;
  const chainDepth = typeof message.metadata?.chainDepth === 'number'
    ? message.metadata.chainDepth
    : 0;
  if (handoffRootMessageId && chainDepth > 0 && deliveryIntent !== 'handoff') {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '范围：本轮根消息及同一 Handoff 接力链；不含房间全部历史或其他讨论。' }],
    }, {
      tag: 'action',
      actions: [{
        tag: 'button',
        type: 'primary',
        text: { tag: 'plain_text', content: '将本轮 Handoff 链生成审批 PLAN' },
        value: {
          cmd: 'handoff-plan',
          roomId: message.roomId,
          rootMessageId: handoffRootMessageId,
          chatType,
        },
      }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: deliveryIntent === 'directed_visible' && targetMemberName
          ? `Direct/私聊回复 · ${message.senderName} → ${targetMemberName}`
          : message.senderName,
      },
    },
    elements,
  };
};

export const extractAssistantRelayImages = (
  content: string,
  workspaceRoot = process.cwd()
) => {
  const imagePaths: string[] = [];
  const text = content.replace(
    /!\[([^\]]*)\]\((<?[^)\s>]+>?)\)/g,
    (_match, alt: string, rawTarget: string) => {
      const target = rawTarget.replace(/^<|>$/g, '');
      if (/^https?:\/\//i.test(target)) {
        return `[${alt || '图片'}](${target})`;
      }

      const filePath = path.resolve(workspaceRoot, target);
      const relativePath = path.relative(workspaceRoot, filePath);
      if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return alt ? `${alt}（图片路径不在工作区）` : '图片路径不在工作区';
      }

      imagePaths.push(filePath);
      return alt || '';
    }
  );

  return { text: text.trim(), imagePaths: Array.from(new Set(imagePaths)) };
};

export async function relayLiveRoomMessageToFeishu(message: LiveRoomMessagePayload) {
  if (!shouldRelayLiveRoomMessage(message)) {
    return;
  }

  const bindings = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT
      "id",
      "appId",
      "chatId",
      "chatType",
      "threadId",
      "rootMessageId",
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
  const target = resolveFeishuRelaySendTarget(binding);

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
    const relay = extractAssistantRelayImages(message.content);
    if (relay.text) {
      try {
        await sendFeishuInteractiveMessage({
          receiveId: target.receiveId,
          receiveIdType: target.receiveIdType,
          card: buildAssistantRelayCard(
            { ...message, content: relay.text },
            binding.chatType === 'p2p' ? 'p2p' : 'group',
          ),
        });
      } catch {
        // Fallback stays inside the same target: for a task thread the fallback
        // text is sent to the thread, never to the group root.
        try {
          await sendFeishuTextMessage({
            receiveId: target.receiveId,
            receiveIdType: target.receiveIdType,
            text: `${message.senderName}\n\n${relay.text}`,
          });
        } catch (fallbackError) {
          console.error('Live Room thread relay failed; refusing group broadcast', {
            bindingId: binding.id,
            threadScoped: target.threadScoped,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
    }
    for (const filePath of relay.imagePaths) {
      await sendFeishuLocalImageMessage({
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        filePath,
      });
    }
  } else {
    await sendFeishuTextMessage({
      receiveId: target.receiveId,
      receiveIdType: target.receiveIdType,
      text: message.content,
    });
  }
}
