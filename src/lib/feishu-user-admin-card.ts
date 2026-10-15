import { getFeishuUserDisplayName, sendFeishuInteractiveMessage, sendFeishuTextMessage } from '@/lib/feishu-api';
import { prisma } from '@/lib/prisma';
import { isFeishuUserAdmin, readFeishuUserAdminDetail, stopFeishuUserRoomRuns, updateFeishuUserAdmin } from '@/lib/feishu-user-admin';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import { resolveWorkspaceRoot } from '@/lib/feishu-workspace';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

const text = (content: string) => ({ tag: 'plain_text', content });
const short = (value: string, limit = 60) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const plain = (value: string) => value.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
const isPlaceholderName = (name: string | null | undefined, openId: string) =>
  !name || name === openId || name.startsWith('openid:');

async function resolveManagedUserName(user: { openId: string; displayName: string | null }) {
  if (!isPlaceholderName(user.displayName, user.openId)) return { name: user.displayName!, lookupError: false };
  try {
    const name = await getFeishuUserDisplayName(user.openId);
    if (name && !isPlaceholderName(name, user.openId)) {
      await prisma.feishuUserAccess.updateMany({
        where: { openId: user.openId, displayName: user.displayName },
        data: { displayName: name, nameUpdatedAt: new Date() },
      });
      return { name, lookupError: false };
    }
  } catch {
    return { name: user.displayName || user.openId, lookupError: true };
  }
  return { name: user.displayName || user.openId, lookupError: false };
}

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
  const { name, lookupError } = await resolveManagedUserName(user);
  const currentProfiles = Array.from(new Set(agents.map(({ permission }) => permission.profile)));
  const selectedProfile = currentProfiles.length === 1 ? currentProfiles[0]
    : room?.sourceTask ? resolveLiveRoomMemberPermission(null, room.sourceTask.acpxPermissionConfig).profile : undefined;
  const effective = agents.length
    ? agents.map(({ member, permission }) => `${member.userNickname || member.displayName}：${permission.profile}，网络 ${permission.networkAccess}，可写 ${permission.writableRoots.join('、') || '未列出'}`).join('\n')
    : '无已绑定 Agent';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: text(short(`管理用户 · ${name}`)) },
    elements: [
      { tag: 'markdown', content: `**姓名**：${plain(isPlaceholderName(name, user.openId) ? '未获取' : name)}\n**open_id**：\`${user.openId}\`\n**准入状态**：${user.status}\n**授权根目录**：\`${user.workspaceRoot || '未设置'}\`\n**私聊工作目录**：\`${room?.workingDirectory || '未创建'}\`\n**私聊任务**：${room?.sourceTask?.name || '未创建'}\n**私聊 Agent 实际权限**：\n${effective}\n\n以下修改只作用于该用户的私聊房间；群聊任务须在各自房间管理。` },
      ...(isPlaceholderName(name, user.openId) ? [{ tag: 'markdown', content: lookupError
        ? '自动获取姓名失败：请为机器人应用开通 contact:user.basic_profile:readonly；也可在下方手动填写姓名。'
        : '暂未获取飞书姓名，可在下方填写。' }] : []),
      { tag: 'form', name: 'feishu-user-admin-name', elements: [
        { tag: 'input', name: 'displayName', required: true,
          default_value: isPlaceholderName(name, user.openId) ? '' : name,
          label: text('用户姓名'), placeholder: text('填写中文姓名') },
        { tag: 'button', name: 'saveFeishuUserName', type: 'primary_filled', width: 'fill',
          text: text('保存姓名'), action_type: 'form_submit',
          value: { cmd: 'feishu-user-admin', action: 'saveName', userOpenId: openId, adminChatId },
        },
      ] },
      ...(['pending', 'denied', 'revoked'].includes(user.status) ? [{
        tag: 'markdown', content: room?.sourceTask
          ? '此用户已有私聊房间：先按当前授权根目录批准，再在批准后的卡片修改目录和 Agent 权限。'
          : '批准时会为该用户创建私聊房间。',
      }, {
        tag: 'form', name: 'feishu-user-admin-approve', elements: [
          { tag: 'input', name: 'approvalWorkspaceRoot', required: true,
            default_value: user.workspaceRoot || '', label: text('批准后的授权根目录'),
            placeholder: text('/absolute/workspace/root') },
          { tag: 'button', name: 'approveFeishuUser', type: 'primary_filled', width: 'fill',
            text: text(user.status === 'pending' ? '批准准入申请' : '重新批准准入'),
            action_type: 'form_submit',
            value: { cmd: 'feishu-user-admin', action: 'approveAccess', userOpenId: openId, adminChatId },
          },
        ],
      }] : []),
      ...(user.status === 'pending' ? [{ tag: 'action', actions: [{
        tag: 'button', type: 'danger', text: text('拒绝准入申请'),
        value: { cmd: 'feishu-user-admin', action: 'denyAccess', userOpenId: openId, adminChatId },
      }] }] : []),
      ...(user.status === 'approved' ? [{ tag: 'action', actions: [
        { tag: 'button', type: 'default', text: text('撤销准入'),
          value: { cmd: 'feishu-user-admin', action: 'revokeAccess', userOpenId: openId, adminChatId } },
        { tag: 'button', type: 'danger', text: text('封禁用户'),
          value: { cmd: 'feishu-user-admin', action: 'blockAccess', userOpenId: openId, adminChatId } },
      ] }] : []),
      ...(user.status === 'blocked' ? [{ tag: 'action', actions: [{
        tag: 'button', type: 'default', text: text('解除封禁'),
        value: { cmd: 'feishu-user-admin', action: 'unblockAccess', userOpenId: openId, adminChatId },
      }] }] : []),
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
      }] : [{ tag: 'markdown', content: user.status === 'approved'
        ? '私聊房间尚未就绪；请先完成房间创建。'
        : '批准准入后，可继续在此卡片调整私聊权限和工作目录。' }]),
    ],
  };
}

async function changeFeishuUserAccess(args: {
  action: string; userOpenId: string; actorOpenId: string; workspaceRoot?: string;
}) {
  const { handleFeishuUserManagementCommand, resolveFeishuAdminApproval } = await import('@/lib/feishu-access-approval');
  const access = await prisma.feishuUserAccess.findUnique({ where: { openId: args.userOpenId } });
  if (!access) throw new Error('找不到该飞书用户。');
  const allowedStatuses: Record<string, string[]> = {
    approveAccess: ['pending', 'denied', 'revoked'], denyAccess: ['pending'],
    revokeAccess: ['approved'], blockAccess: ['approved'], unblockAccess: ['blocked'],
  };
  if (!allowedStatuses[args.action]?.includes(access.status)) {
    throw new Error('用户状态已变化，请重新打开管理卡片。');
  }
  if (args.action === 'approveAccess' || args.action === 'denyAccess') {
    if (args.action === 'approveAccess') {
      const requestedRoot = await resolveWorkspaceRoot(args.workspaceRoot || '');
      const detail = await readFeishuUserAdminDetail(args.userOpenId);
      if (detail.room?.sourceTask && detail.user.workspaceRoot
        && requestedRoot !== await resolveWorkspaceRoot(detail.user.workspaceRoot)) {
        throw new Error('已有私聊房间：请先按当前授权根目录批准，再在批准后的卡片修改目录。');
      }
    }
    const approval = access.status === 'pending' ? await prisma.feishuAdminApproval.findFirst({
      where: { requesterOpenId: args.userOpenId, requesterChatId: access.chatId || undefined,
        kind: 'user_pairing', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }) : null;
    if (approval) {
      const resolved = await resolveFeishuAdminApproval({
        approvalId: approval.id, approved: args.action === 'approveAccess',
        actorOpenId: args.actorOpenId, workspaceRoot: args.workspaceRoot,
      });
      return resolved ? args.action === 'approveAccess' ? '准入申请已批准。' : '准入申请已拒绝。'
        : '准入申请已由其他操作处理，请刷新卡片。';
    }
    if (args.action === 'denyAccess') throw new Error('找不到待处理的准入申请，请刷新卡片。');
  }
  const commandAction = {
    approveAccess: 'approve', revokeAccess: 'revoke', blockAccess: 'block', unblockAccess: 'unblock',
  }[args.action];
  if (!commandAction) throw new Error('不支持此准入操作。');
  const result = await handleFeishuUserManagementCommand({
    command: { command: 'user', args: [commandAction, args.userOpenId],
      options: args.workspaceRoot ? { 'workspace-root': args.workspaceRoot } : {} },
    senderOpenId: args.actorOpenId,
  });
  if (args.action === 'revokeAccess' || args.action === 'blockAccess') {
    const warning = await stopFeishuUserRoomRuns(args.userOpenId);
    return warning ? `${result} 但${warning}` : result;
  }
  return result;
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
  if (args.value.action === 'saveName') {
    const name = args.formValue?.displayName;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
      return { toast: { type: 'warning', content: '请填写不超过 64 个字符的姓名。' } };
    }
    await prisma.feishuUserAccess.update({
      where: { openId: selected },
      data: { displayName: name.trim(), nameUpdatedAt: new Date() },
    });
    return { toast: { type: 'success', content: '姓名已保存；重新打开 /ap users 可在列表中看到。' },
      card: { type: 'raw', data: await buildFeishuUserDetailCard(selected, args.chatId) } };
  }
  if (['approveAccess', 'denyAccess', 'revokeAccess', 'blockAccess', 'unblockAccess'].includes(String(args.value.action))) {
    const root = args.formValue?.approvalWorkspaceRoot;
    if (args.value.action === 'approveAccess' && (typeof root !== 'string' || !root.trim())) {
      return { toast: { type: 'warning', content: '请填写批准后的授权根目录。' } };
    }
    const chatId = args.chatId;
    const action = String(args.value.action);
    void changeFeishuUserAccess({ action, userOpenId: selected, actorOpenId: args.actorOpenId!,
      workspaceRoot: typeof root === 'string' ? root : undefined })
      .then(async (result) => {
        await sendFeishuTextMessage({ receiveId: chatId, receiveIdType: 'chat_id', text: result });
        await sendFeishuInteractiveMessage({ receiveId: chatId, receiveIdType: 'chat_id',
          card: await buildFeishuUserDetailCard(selected, chatId) });
      })
      .catch((error) => sendFeishuTextMessage({ receiveId: chatId, receiveIdType: 'chat_id',
        text: `❌ 准入操作失败：${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined));
    return { toast: { type: 'success', content: '准入操作已接收，结果将发到当前私聊。' } };
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
