import { prisma } from '@/lib/prisma';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import { buildFeishuTaskEntryCard } from '@/lib/feishu-room-create-card';
import { getFeishuTaskThread, isFeishuGroupAdmin, updateFeishuTaskEntryCard } from '@/lib/feishu-task-entry-api';
import { resolveWorkspaceDirectory, resolveWorkspaceRoot } from '@/lib/feishu-workspace';
import {
  confirmFeishuTaskBinding, isFeishuTaskIsolationEnabled, recordFeishuTaskRoot,
  reserveFeishuTaskBinding, setFeishuTaskIsolation,
} from '@/lib/feishu-task-binding';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

const OFF = '隔离模式已关闭，已有任务仍保持隔离';

export async function handleFeishuTaskCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (!context || context.chatType !== 'group' || context.threadId || context.rootId || context.parentMessageId) {
    return '请在群根会话操作任务隔离与创建入口；已有任务请在原话题续聊。';
  }
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (!appId || (context.appId && context.appId !== appId) || !context.senderOpenId) {
    return '无法验证当前飞书应用或操作者身份。';
  }
  const scope = { appId, chatId: context.chatId };
  const action = command.args[0] || 'status';
  if (command.command === 'isolation') {
    if (!['status', 'on', 'off'].includes(action) || command.args.length > 1) return '用法：/ap isolation [status|on|off]';
    if (action !== 'status') {
      if (!isFeishuAdmin(context.senderOpenId) && !await isFeishuGroupAdmin(scope.chatId, context.senderOpenId)) {
        return '仅经验证的群主、群管理员或平台管理员可修改隔离模式。';
      }
      await setFeishuTaskIsolation(scope, action === 'on');
    }
    return await isFeishuTaskIsolationEnabled(scope)
      ? '隔离模式已开启。创建任务：/ap task new --title=任务名 --workdir=<目录>' : OFF;
  }
  if (!['new', 'retry'].includes(action)) return '用法：/ap task new --title=任务名 --workdir=<目录>；/ap task retry <请求ID>';
  if (!await isFeishuTaskIsolationEnabled(scope)) return OFF;
  let request;
  if (action === 'retry') {
    if (command.args.length !== 2) return '用法：/ap task retry <请求ID>';
    request = await prisma.feishuTaskBindingRequest.findFirst({ where: { id: command.args[1], ...scope } });
    if (!request) return '当前群没有该任务创建请求。';
  } else {
    const title = command.options.title?.trim();
    const directory = command.options.workdir?.trim();
    if (!title || !directory || command.args.length !== 1 || !context.messageId) {
      return '请明确任务名和工作目录：/ap task new --title=任务名 --workdir=<目录>';
    }
    // Keep group history and member sessions out of the new task. Add members in
    // its own topic with the existing /ap add command after stable binding.
    const access = await prisma.feishuUserAccess.findUnique({ where: { openId: context.senderOpenId } });
    const workingDirectory = access?.workspaceRoot && !isFeishuAdmin(context.senderOpenId)
      ? await resolveWorkspaceDirectory(access.workspaceRoot, directory) : await resolveWorkspaceRoot(directory);
    request = await reserveFeishuTaskBinding({ ...scope, sourceMessageId: context.messageId, title, workingDirectory });
  }
  try {
    // Feishu deduplicates send UUIDs for one hour. Stop early rather than create
    // another entry when an old successful response might have been lost.
    const maySend = Date.now() - request.createdAt.getTime() < 50 * 60_000;
    let rootMessageId = request.rootMessageId;
    if (!rootMessageId) {
      if (!maySend) throw new Error('创建请求已超过安全重试窗口，请管理员核对原卡片，勿重复创建');
      rootMessageId = await sendFeishuInteractiveMessage({
        receiveId: scope.chatId, uuid: request.id,
        card: buildFeishuTaskEntryCard(request.title, request.id),
      }) || null;
      if (!rootMessageId) throw new Error('飞书未返回入口消息 ID');
      await recordFeishuTaskRoot(scope, request.id, rootMessageId);
    }
    const threadId = await getFeishuTaskThread({ ...scope, rootMessageId, requestId: request.id, mayReply: maySend });
    const binding = await confirmFeishuTaskBinding(scope, request.id, { ...scope, threadId, rootMessageId });
    const room = await prisma.liveRoom.findUniqueOrThrow({ where: { id: binding.liveRoomId }, select: { status: true } });
    await updateFeishuTaskEntryCard(rootMessageId, buildFeishuTaskEntryCard(request.title, request.id, room.status === 'archived' ? 'archived' : 'ready'));
    return room.status === 'archived' ? '该任务已归档，不会隐式恢复执行。' : `任务入口已就绪：${request.title}。请在入口卡片的话题中用 /ap add 添加成员后续聊。`;
  } catch (error) {
    return `任务创建尚未完成：${error instanceof Error ? error.message : String(error)}\n保留原请求，可使用 /ap task retry ${request.id} 恢复。`;
  }
}
