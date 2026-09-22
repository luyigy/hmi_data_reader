import { replyFeishuMessage, sendFeishuTextMessage } from '@/lib/feishu-api';

export type FeishuTopicIdentity = {
  threadId?: string;
  rootId?: string;
  parentMessageId?: string;
};

/** Topic identity carried from the verified im.message.receive_v1 payload into
 *  every FeishuConversationContext. thread_id / root_id / parent_id stay
 *  distinct fields; they are never merged or converted into each other. */
export const buildFeishuTopicIdentity = (message: {
  threadId?: string;
  rootId?: string;
  parentId?: string;
}): FeishuTopicIdentity => ({
  ...(message.threadId ? { threadId: message.threadId } : {}),
  ...(message.rootId ? { rootId: message.rootId } : {}),
  ...(message.parentId ? { parentMessageId: message.parentId } : {}),
});

export const hasFeishuTopicIdentityFields = (identity: FeishuTopicIdentity) =>
  !!(identity.threadId || identity.rootId || identity.parentMessageId);

/** Answer inside the sender's conversation via the verified reply API so topic
 *  messages stay in their topic. On reply failure a topic-scoped message must
 *  NOT degrade to a plain group broadcast — log and keep the failure visible. */
export async function replyToFeishuConversation(args: {
  chatId: string;
  messageId: string;
  text: string;
  topicScoped: boolean;
}) {
  try {
    await replyFeishuMessage({
      messageId: args.messageId,
      msgType: 'text',
      content: { text: args.text },
    });
  } catch (error) {
    if (args.topicScoped) {
      console.error('Feishu topic reply failed; refusing group fallback', {
        chatId: args.chatId,
        messageId: args.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await sendFeishuTextMessage({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      text: args.text,
    });
  }
}
