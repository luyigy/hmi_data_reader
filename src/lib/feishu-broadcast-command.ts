import { prisma } from '@/lib/prisma';
import { checkFeishuDirectMessageAccess } from '@/lib/feishu-access-approval';
import { isFeishuTaskIsolationEnabled } from '@/lib/feishu-task-binding';
import { publishFeishuGroupBroadcast } from '@/lib/feishu-task-broadcast';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

export async function handleFeishuBroadcastCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (!context || context.chatType !== 'group' || context.threadId || context.rootId || context.parentMessageId) {
    return '请在群主聊天区使用 /ap broadcast <通知原文>；话题内不会发布群广播。';
  }
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (!appId || (context.appId && context.appId !== appId) || !context.senderOpenId || !context.messageId) {
    return '无法验证当前飞书应用、操作者或来源消息。';
  }
  // Group speech follows the existing inbound access policy; explicitly blocked
  // users must not gain a cross-task publishing path.
  const access = await prisma.feishuUserAccess.findUnique({ where: { openId: context.senderOpenId } });
  if (access?.status === 'blocked' || !await checkFeishuDirectMessageAccess(context)) return '当前用户无权发布广播。';
  const content = command.args[0] || '';
  if (!content.trim()) return '广播内容不能为空。用法：/ap broadcast <通知原文>';
  const scope = { appId, chatId: context.chatId };
  if (!await isFeishuTaskIsolationEnabled(scope)) return '隔离模式已关闭，拒绝新增广播；已记录广播仍对原目标任务有效。';
  const { created, broadcast } = await publishFeishuGroupBroadcast({
    ...scope, sourceMessageId: context.messageId, senderOpenId: context.senderOpenId, content,
  });
  return `${created ? '已记录' : '已记录（重复消息）'}广播 #${broadcast.sequence} [${broadcast.id}]，目标任务 ${broadcast.targets.length} 个。\n目标任务各成员下一轮可见；不主动唤醒、不立即打断。此回执不表示执行上下文已接收或 Agent 已理解。`;
}
