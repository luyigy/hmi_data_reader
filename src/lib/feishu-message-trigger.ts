import type { ParsedFeishuMessage } from '@/lib/feishu-message-content';

export function shouldTriggerFeishuMessage(
  message: Pick<ParsedFeishuMessage, 'chatType' | 'mentions'>,
  botOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim()
): boolean {
  if (message.chatType === 'p2p') return true;
  // Group messages require a structured mention of this bot, never a display name.
  return message.chatType === 'group' && !!botOpenId && message.mentions.includes(botOpenId);
}
