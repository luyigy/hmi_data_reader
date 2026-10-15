import { sendFeishuInteractiveMessage, sendFeishuTextMessage } from '@/lib/feishu-api';
import { prisma } from '@/lib/prisma';
import { isFeishuUserAdmin, readFeishuUserAdminDetail, updateFeishuUserAdmin } from '@/lib/feishu-user-admin';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

const text = (content: string) => ({ tag: 'plain_text', content });
const short = (value: string, limit = 60) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const plain = (value: string) => value.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');

export async function buildFeishuUserListCard(chatId: string, status?: string) {
  const users = await prisma.feishuUserAccess.findMany({
    where: status ? { status } : undefined,
    orderBy: { updatedAt: 'desc' }, take: 100,
  });
  const bindings = await prisma.feishuConversationBinding.findMany({
    where: { chatType: 'p2p', chatId: { in: users.flatMap((user) => user.chatId ? [user.chatId] : []) } },
    select: {
      chatId: true, senderOpenId: true,
      liveRoom: { select: {
        sourceTask: { select: { acpxPermissionConfig: true } },
        members: { where: { canReply: true }, select: { memberType: true, acpxPermissionConfig: true } },
      } },
    },
  });
  const rooms = new Map(bindings.map((binding) => [`${binding.chatId}:${binding.senderOpenId}`, binding.liveRoom]));
  const rows = users.map((user) => {
    const room = rooms.get(`${user.chatId}:${user.openId}`);
    const agents = room?.members.filter((member) => member.memberType !== 'user') ?? [];
    const describePermission = (config: ReturnType<typeof resolveLiveRoomMemberPermission>) =>
      `${config.profile}（${config.networkAccess === 'enabled' ? '联网' : '离线'}）`;
    const permissions = Array.from(new Set(agents.map((member) => describePermission(resolveLiveRoomMemberPermission(
      member.acpxPermissionConfig, room?.sourceTask?.acpxPermissionConfig,
    )))));
    const permission = permissions.length > 1 ? '混合权限'
      : permissions[0] || (room?.sourceTask ? describePermission(resolveLiveRoomMemberPermission(null, room.sourceTask.acpxPermissionConfig)) : '无私聊任务');
    return { user, permission };
  });
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: text('飞书用户管理') },
    elements: [
      { tag: 'markdown', content: `最近 ${users.length} 位${status ? ` · 状态：${status}` : ''}，下方显示前 ${Math.min(users.length, 20)} 位的准入、目录和私聊权限。选择任一用户查看完整权限并修改。超过 100 位时可用 \`/ap users --status=approved\` 等筛选。` },
      ...(rows.length ? [{ tag: 'markdown', content: rows.slice(0, 20).map(({ user, permission }) =>
        `• **${plain(short(user.displayName || user.openId, 30))}** · ${plain(user.status)} · ${plain(permission)} · \`${plain(short(user.workspaceRoot || '未分配目录', 80))}\``,
      ).join('\n') }] : []),
      ...(users.length ? [{
        tag: 'form', name: 'feishu-user-admin-list', elements: [
          {
            tag: 'select_static', name: 'selectedUser', required: true, width: 'fill',
            placeholder: text('选择飞书用户'),
            options: rows.map(({ user, permission }) => ({
              text: text(short(`${user.displayName || user.openId} · ${user.status} · ${permission} · ${user.workspaceRoot || '未分配目录'}`)),
              value: user.openId,
            })),
          },
          { tag: 'button', name: 'viewFeishuUser', type: 'primary_filled', width: 'fill',
            text: text('查看与调整'), action_type: 'form_submit',
            value: { cmd: 'feishu-user-admin', action: 'view', adminChatId: chatId },
          },
        ],
      }] : [{ tag: 'markdown', content: '暂无匹配用户。' }]),
    ],
  };
}

export async function sendFeishuUserAdminCard(context: FeishuConversationContext, status?: string) {
  if (!isFeishuUserAdmin(context.senderOpenId)) return '仅配置的飞书管理员可以管理用户。';
  if (context.chatType !== 'p2p') return '请在与机器人的私聊中打开用户管理卡。';
  const card = await buildFeishuUserListCard(context.chatId, status);
  await sendFeishuInteractiveMessage({
    receiveId: context.chatId, receiveIdType: 'chat_id', replyId: context.messageId, card,
  });
  return '已发送飞书用户管理卡。';
}

export async function buildFeishuUserDetailCard(openId: string, adminChatId: string) {
  const { user, room, agents } = await readFeishuUserAdminDetail(openId);
  const currentProfiles = Array.from(new Set(agents.map(({ permission }) => permission.profile)));
  const selectedProfile = currentProfiles.length === 1 ? currentProfiles[0]
    : room?.sourceTask ? resolveLiveRoomMemberPermission(null, room.sourceTask.acpxPermissionConfig).profile : undefined;
  const effective = agents.length
    ? agents.map(({ member, permission }) => `${member.userNickname || member.displayName}：${permission.profile}，网络 ${permission.networkAccess}，可写 ${permission.writableRoots.join('、') || '未列出'}`).join('\n')
    : '无已绑定 Agent';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: text(short(`管理用户 · ${user.displayName || user.openId}`)) },
    elements: [
      { tag: 'markdown', content: `**open_id**：\`${user.openId}\`\n**准入状态**：${user.status}\n**授权根目录**：\`${user.workspaceRoot || '未设置'}\`\n**私聊工作目录**：\`${room?.workingDirectory || '未创建'}\`\n**私聊任务**：${room?.sourceTask?.name || '未创建'}\n**私聊 Agent 实际权限**：\n${effective}\n\n以下修改只作用于该用户的私聊房间；群聊任务须在各自房间管理。` },
      ...(user.status === 'approved' && room?.sourceTask ? [{
        tag: 'form', name: 'feishu-user-admin-edit', elements: [
          { tag: 'input', name: 'workspaceRoot', required: true, default_value: user.workspaceRoot || '',
            label: text('授权根目录（必须已存在）'), placeholder: text('/absolute/workspace/root') },
          { tag: 'select_static', name: 'profile', required: true, width: 'fill',
            placeholder: text('选择私聊 Agent 权限'),
            ...(selectedProfile === 'safe_local' || selectedProfile === 'dev_local' ? { initial_option: selectedProfile } : {}),
            options: [
              { text: text('Safe Local · 工作区隔离、离线'), value: 'safe_local' },
              { text: text('Dev Local · 工作区隔离、联网'), value: 'dev_local' },
            ] },
          { tag: 'button', name: 'saveFeishuUser', type: 'primary_filled', width: 'fill',
            text: text('保存目录和权限'), action_type: 'form_submit',
            value: { cmd: 'feishu-user-admin', action: 'save', userOpenId: openId, adminChatId },
          },
        ],
      }] : [{ tag: 'markdown', content: '此用户尚无已批准的私聊房间；请先处理准入申请。' }]),
    ],
  };
}

export async function handleFeishuUserAdminCardCallback(args: {
  value: Record<string, unknown>;
  formValue?: Record<string, unknown>;
  actorOpenId?: string;
  chatId?: string;
}) {
  if (!isFeishuUserAdmin(args.actorOpenId) || !args.chatId
    || args.value.adminChatId !== args.chatId) {
    return { toast: { type: 'warning', content: '仅管理员可在原私聊操作此卡片。' } };
  }
  const selected = args.value.action === 'view'
    ? args.formValue?.selectedUser : args.value.userOpenId;
  if (typeof selected !== 'string' || !selected) {
    return { toast: { type: 'warning', content: '请先选择用户。' } };
  }
  if (args.value.action === 'view') {
    try {
      return { toast: { type: 'success', content: '已打开用户详情' },
        card: { type: 'raw', data: await buildFeishuUserDetailCard(selected, args.chatId) } };
    } catch (error) {
      return { toast: { type: 'warning', content: error instanceof Error ? error.message : '用户详情读取失败' } };
    }
  }
  if (args.value.action !== 'save') return {};
  const root = args.formValue?.workspaceRoot;
  const profile = args.formValue?.profile;
  if (typeof root !== 'string' || !root.trim()
    || (profile !== 'safe_local' && profile !== 'dev_local')) {
    return { toast: { type: 'warning', content: '请填写现有目录并选择 Safe Local 或 Dev Local。' } };
  }
  const chatId = args.chatId;
  const actorOpenId = args.actorOpenId;
  void updateFeishuUserAdmin({ actorOpenId, userOpenId: selected, workspaceRoot: root, profile })
    .then(async (result) => {
      await sendFeishuTextMessage({ receiveId: chatId, receiveIdType: 'chat_id', text: result });
      await sendFeishuInteractiveMessage({ receiveId: chatId, receiveIdType: 'chat_id',
        card: await buildFeishuUserDetailCard(selected, chatId) });
    })
    .catch((error) => sendFeishuTextMessage({ receiveId: chatId, receiveIdType: 'chat_id',
      text: `❌ 用户管理未完成：${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined));
  return { toast: { type: 'success', content: '正在更新用户目录和权限，结果将发到当前私聊。' } };
}
