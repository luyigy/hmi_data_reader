import { graphRecoveryKind } from './implementation-result';
import { prisma } from '../prisma';
import { replyFeishuMessage } from '../feishu-api';
import { requestGraphConversationRecovery } from './conversation-recovery';

export type GraphContinuationInput = { roomId: string; chatId: string; openId: string; messageId: string; text: string; nodeKey?: string; chatType?: string; threadId?: string };

/** Explicit model/menu actions use factual authorization; ordinary text is never classified here. */
export async function handleGraphConversationIntent(args: GraphContinuationInput, fromControl = false) {
  if (!fromControl || !args.nodeKey) return false;
  const origin = await prisma.liveRoomMessage.findFirst({ where: { roomId: args.roomId, messageType: 'user', content: args.text,
    AND: [{ metadata: { contains: JSON.stringify({ feishuMessageId: args.messageId }).slice(1, -1) } },
      { metadata: { contains: JSON.stringify({ feishuSenderOpenId: args.openId }).slice(1, -1) } }] } });
  if (!origin) throw new Error('恢复控制缺少可核验的原始用户消息');
  const event = await requestGraphConversationRecovery(args);
  const recoveryKind = event.nodeId ? await graphRecoveryKind(event.nodeId) : null;
  const text = event.kind === 'conversation_review_already_running' ? '原任务正在执行，不会重复启动。'
    : event.kind === 'conversation_review_already_complete' ? '原任务已经交付，保留现有验收状态。'
    : recoveryKind === 'implementation' ? '已登记接回原任务实施，平台核验当前保存点和写入者归属。' : '已登记接回原任务验收。';
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoomId: args.roomId, chatId: args.chatId }, select: { chatType: true, threadId: true } });
  await replyFeishuMessage({ messageId: args.messageId, msgType: 'text', content: { text },
    replyInThread: (args.chatType || binding?.chatType) !== 'p2p' || !!(args.threadId || binding?.threadId), uuid: `graph-continue-${event.id}` });
  return true;
}

export async function applyGraphControlOutput(args: { output: string; roomId: string; sourceContent: string; sourceMetadata: string | null }) {
  const pattern = /<graph-control>([\s\S]*?)<\/graph-control>/g;
  const blocks = Array.from(args.output.matchAll(pattern));
  if (!blocks.length) return args.output;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(args.sourceMetadata || '{}'); } catch { /* No authenticated inbound origin. */ }
  let message = '未恢复任务：控制块缺少有效的人类授权来源。';
  if (blocks.length === 1 && metadata.source === 'feishu' && typeof metadata.feishuSenderOpenId === 'string' && typeof metadata.feishuChatId === 'string' && typeof metadata.feishuMessageId === 'string') {
    try {
      const command = JSON.parse(blocks[0][1]);
      if (!['resume_task', 'resume_acceptance'].includes(command.action) || typeof command.nodeKey !== 'string') throw new Error('无效的任务恢复指令');
      const handled = await handleGraphConversationIntent({ roomId: args.roomId, chatId: metadata.feishuChatId, openId: metadata.feishuSenderOpenId,
        messageId: metadata.feishuMessageId, text: args.sourceContent, nodeKey: command.nodeKey }, true);
      message = handled ? '平台已回复本次继续请求，请以平台状态回报为准。' : '本条消息没有明确要求继续执行，任务状态保持。';
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
  }
  return [args.output.replace(pattern, '').trim(), message].filter(Boolean).join('\n\n');
}
