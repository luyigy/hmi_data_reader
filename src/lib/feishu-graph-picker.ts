import { getBoundLiveRoom, type FeishuConversationContext } from './feishu-live-room';
import { assertFeishuDocumentAccess } from './feishu-document-command';
import { replyFeishuMessage } from './feishu-api';
import { prisma } from './prisma';
import { listSpecPackages } from './task-graph/spec-package';

export function buildGraphSpecPicker(args: { roomId: string; commit: string; packages: { title: string; manifestPath: string }[] }) {
  return { schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '选择 Spec，提出任务路线' } },
    body: { elements: [
      { tag: 'markdown', content: '选择已提交且 ready 的 Spec 包。Agent 将整理 tickets、依赖和建议角色，发送附件与路线卡。此操作不启动实施。' },
      { tag: 'form', name: 'graph_spec_picker', elements: [
        { tag: 'select_static', name: 'selectedSpec', width: 'fill', required: true,
          placeholder: { tag: 'plain_text', content: '选择待提审 Spec' },
          options: args.packages.slice(0, 100).map((item) => ({ value: item.manifestPath, text: { tag: 'plain_text', content: item.title } })) },
        { tag: 'button', name: `tgs:${args.roomId}:${args.commit}`, form_action_type: 'submit', type: 'primary_filled',
          text: { tag: 'plain_text', content: '发送路线提审' },
        },
      ] },
    ] } };
}

export async function openGraphSpecPicker(context: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  const repository = room?.sourceTask?.workingDirectory || room?.workingDirectory;
  if (!room?.sourceTaskId || !repository) return '当前父任务没有可选择 Spec 的工作目录。';
  await assertFeishuDocumentAccess(context, repository);
  const { commit, packages: allPackages } = await listSpecPackages(repository);
  const packages = allPackages.filter((item) => item.issueRoute);
  if (!packages.length) return '当前仓库没有已提交且 ready 的 Issue Spec 包。请先让 Agent 在 docs/specs/<主题>/ 准备 spec.md、提审 HTML 和 spec-package.json，登记父 Issue 与各片执行配置。依赖从 Issues 读取。';
  await replyFeishuMessage({ messageId: context.messageId, msgType: 'interactive',
    content: buildGraphSpecPicker({ roomId: room.id, commit, packages }) });
  return '已发送 Spec 选择卡；选中后点击“发送路线提审”。';
}

export async function graphCardContext(args: {
  roomId?: string; chatId: string; openId: string; messageId: string; chatType: string;
}): Promise<FeishuConversationContext> {
  if (!args.roomId) return { chatId: args.chatId, senderOpenId: args.openId, messageId: args.messageId, chatType: args.chatType };
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoomId: args.roomId, chatId: args.chatId } });
  if (!binding) throw new Error('命令卡与父任务绑定不匹配，请回到原任务重新打开菜单');
  return { chatId: binding.chatId, chatType: binding.chatType, senderOpenId: args.openId,
    messageId: args.messageId, appId: binding.appId || undefined,
    rootId: binding.rootMessageId || undefined, threadId: binding.threadId || undefined };
}

export async function handleGraphSpecPicker(args: {
  value: Record<string, unknown>; formValue: Record<string, unknown>; openId?: string; chatId?: string; messageId?: string;
}) {
  if (!args.openId || !args.chatId || !args.messageId || typeof args.value.roomId !== 'string'
    || typeof args.value.commit !== 'string' || typeof args.formValue.selectedSpec !== 'string') {
    return { toast: { type: 'warning', content: 'Spec 选择卡信息不完整，请重新打开' } };
  }
  const context = await graphCardContext({ roomId: args.value.roomId, chatId: args.chatId,
    openId: args.openId, messageId: args.messageId, chatType: 'group' });
  const room = await getBoundLiveRoom(context);
  const repository = room?.sourceTask?.workingDirectory || room?.workingDirectory;
  if (!repository) return { toast: { type: 'warning', content: '工作目录已失效' } };
  await assertFeishuDocumentAccess(context, repository);
  const { commit, packages } = await listSpecPackages(repository);
  const selected = packages.find((item) => item.manifestPath === args.formValue.selectedSpec);
  if (commit !== args.value.commit || !selected) return { toast: { type: 'warning', content: 'Spec 列表已变化，请重新打开选择卡' } };
  const { proposeIssueSpec } = await import('./task-graph/propose-spec');
  const proposal = await proposeIssueSpec({ repository, commit, manifestPath: selected.manifestPath,
    parentTaskId: room!.sourceTaskId!, createdBy: args.openId });
  return { toast: { type: 'success', content: `已从 Issues 生成路线 V${proposal.version}，请核对确认卡。尚未启动。` } };
}
