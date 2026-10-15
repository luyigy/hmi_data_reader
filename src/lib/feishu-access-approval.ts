import { prisma } from '@/lib/prisma';
import { getFeishuUserDisplayName, sendFeishuInteractiveMessage, sendFeishuTextMessage, updateFeishuApprovalCardResolved } from '@/lib/feishu-api';
import { ensureFeishuConversationBinding } from '@/lib/feishu-live-room';
import { resolveWorkspaceDirectory, resolveWorkspaceRoot } from '@/lib/feishu-workspace';
import { interruptLiveRoomRunningProcess } from '@/lib/live-room-process-registry';
import { sendFeishuUserAdminCard } from '@/lib/feishu-user-admin-card';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

type StoredCommand = {
  command: Parameters<typeof import('@/lib/feishu').handleFeishuCommand>[0]['command'];
  baseUrl: string;
  context: NonNullable<Parameters<typeof import('@/lib/feishu').handleFeishuCommand>[0]['context']>;
};

const adminOpenId = () => process.env.FEISHU_ADMIN_OPEN_ID?.trim() || '';
const fallbackDisplayName = (openId: string) => `openid:...${openId.slice(-6)}`;

export const isFeishuAdmin = (openId: string | null | undefined) => !!openId && openId === adminOpenId();

async function sendAdminCard(args: { id: string; title: string; detail: string; workspaceRootInput?: boolean }) {
  const admin = adminOpenId();
  if (!admin) throw new Error('Missing required environment variable: FEISHU_ADMIN_OPEN_ID');
  await sendFeishuInteractiveMessage({
    receiveId: admin,
    receiveIdType: 'open_id',
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: args.title } },
      elements: [
        { tag: 'markdown', content: args.detail },
        ...(args.workspaceRootInput ? [{ tag: 'input', name: 'workspaceRoot', required: true, placeholder: { tag: 'plain_text', content: '/absolute/workspace/root' } }] : []),
        { tag: 'action', actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '批准' }, value: { cmd: `admin-approval:approve:${args.id}` }, ...(args.workspaceRootInput ? { form_action_type: 'submit' } : {}) },
          { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '拒绝' }, value: { cmd: `admin-approval:deny:${args.id}` } },
        ] },
      ],
    },
  });
}

export async function checkFeishuDirectMessageAccess(args: {
  chatId: string;
  chatType: string;
  messageId: string;
  senderOpenId: string;
}) {
  if (args.chatType !== 'p2p' || isFeishuAdmin(args.senderOpenId)) return true;
  const access = await prisma.feishuUserAccess.findUnique({ where: { openId: args.senderOpenId } });
  if (access?.status === 'approved' && access.workspaceRoot) {
    const binding = await prisma.feishuConversationBinding.findFirst({
      where: { chatId: args.chatId, chatType: 'p2p', senderOpenId: args.senderOpenId },
    });
    return !!binding && access.chatId === args.chatId;
  }
  if (access?.status === 'approved') {
    await sendFeishuTextMessage({ receiveId: args.chatId, receiveIdType: 'chat_id', replyId: args.messageId, text: '你的账号已批准，但尚未配置授权根目录。请联系管理员执行 /ap user workspace。' });
    return false;
  }
  if (access?.status === 'blocked') {
    await sendFeishuTextMessage({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      replyId: args.messageId,
      text: '你的访问已被管理员禁用。',
    });
    return false;
  }

  const pendingApproval = await prisma.feishuAdminApproval.findFirst({
    where: { requesterOpenId: args.senderOpenId, kind: 'user_pairing', status: 'pending' },
  });
  if (!pendingApproval) {
    const displayName = await getFeishuUserDisplayName(args.senderOpenId).catch(() => null);
    const resolvedName = displayName || access?.displayName || fallbackDisplayName(args.senderOpenId);
    await prisma.feishuUserAccess.upsert({
      where: { openId: args.senderOpenId },
      create: { openId: args.senderOpenId, chatId: args.chatId, displayName: resolvedName, nameUpdatedAt: displayName ? new Date() : null },
      update: { status: 'pending', chatId: args.chatId, displayName: resolvedName, nameUpdatedAt: displayName ? new Date() : access?.nameUpdatedAt, decidedAt: null, decidedBy: null },
    });
    const approval = await prisma.feishuAdminApproval.create({
      data: { kind: 'user_pairing', requesterOpenId: args.senderOpenId, requesterChatId: args.chatId },
    });
    await sendAdminCard({
      id: approval.id,
      title: 'Feishu 用户准入审批',
      detail: `姓名：${resolvedName}\nopen_id：\`${args.senderOpenId}\`\n来源 chatId：\`${args.chatId}\``,
      workspaceRootInput: true,
    });
  }

  await sendFeishuTextMessage({
    receiveId: args.chatId,
    receiveIdType: 'chat_id',
    replyId: args.messageId,
    text: `你的 open_id：${args.senderOpenId}\n当前状态：等待管理员审批。批准后请重新发送消息。`,
  });
  return false;
}

export function commandRequestsFullAccess(command: StoredCommand['command']) {
  if (command.command === 'rights') return true;
  if (!['grant', 'room', 'new-session'].includes(command.command)) return false;
  const values = [command.options.profile, command.options.rights, command.options.permission, command.options.access, command.args[0]];
  return values.some((value) => ['full', 'full_access', 'full-access'].includes(value?.trim().toLowerCase() || ''));
}

export function buildFullAccessApprovedCommand(command: StoredCommand['command']): StoredCommand['command'] {
  if (command.command !== 'grant' && command.command !== 'rights') return command;
  const agent = command.options.agent?.trim();
  return {
    command: 'new-session',
    args: agent ? [agent] : [],
    options: { ...(agent ? { agent } : { all: 'true' }), profile: 'full_access' },
  };
}

export async function requestFullAccessApproval(args: StoredCommand) {
  const existing = await prisma.feishuAdminApproval.findFirst({
    where: { requesterOpenId: args.context.senderOpenId, kind: 'full_access', status: 'pending', expiresAt: { gt: new Date() } },
  });
  if (existing) {
    return '已有一项待审批的 Full Access（完全访问）权限申请；批准前不会提升权限或启动新的 Agent 运行。';
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const storedArgs: StoredCommand = { ...args, command: buildFullAccessApprovedCommand(args.command) };
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { chatId: args.context.chatId },
    select: { liveRoom: { select: { workingDirectory: true, sourceTask: { select: { workingDirectory: true } } } } },
  });
  const workdir = binding?.liveRoom.workingDirectory
    || binding?.liveRoom.sourceTask?.workingDirectory
    || '(新房间将在管理员批准的 workspace 中启动)';
  const approval = await prisma.feishuAdminApproval.create({
    data: {
      kind: 'full_access',
      requesterOpenId: args.context.senderOpenId,
      requesterChatId: args.context.chatId,
      payloadJson: JSON.stringify(storedArgs),
      expiresAt,
    },
  });
  await sendAdminCard({
    id: approval.id,
    title: 'Full Access 审批',
    detail: [
      `申请人：\`${args.context.senderOpenId}\``,
      `命令：\`${args.command.command} ${args.command.args.join(' ')}\``,
      `当前 workdir：\`${workdir}\``,
      '授权范围：Full Access（独立管理员升级；普通 permission card 无法授予）',
      ...(['grant', 'rights'].includes(args.command.command)
        ? [`授权对象：${args.command.options.agent?.trim() || '当前房间全部可回复 Agent（含房间默认权限）'}`]
        : []),
      '生效方式：仅新 Session；不会恢复或热升级旧进程',
      `有效期：${expiresAt.toISOString()}`,
    ].join('\n'),
  });
  return '🔐 已向管理员提交 Full Access（完全访问）权限申请；批准前不会提升当前权限，也不会启动新的 Agent 运行。';
}

export async function resolveFeishuAdminApproval(args: {
  approvalId: string;
  approved: boolean;
  actorOpenId: string | null | undefined;
  cardMessageId?: string;
  workspaceRoot?: string;
}) {
  if (!isFeishuAdmin(args.actorOpenId)) throw new Error('Only the configured Feishu administrator may resolve this approval.');
  const now = new Date();
  const updated = await prisma.feishuAdminApproval.updateMany({
    where: { id: args.approvalId, status: 'pending', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    data: { status: 'processing', resolvedBy: args.actorOpenId, resolvedAt: now },
  });
  if (updated.count !== 1) return false;
  const approval = await prisma.feishuAdminApproval.findUniqueOrThrow({ where: { id: args.approvalId } });

  let responseText = args.approved ? '审批已批准。' : '审批已拒绝。';
  try {
    if (approval.kind === 'user_pairing') {
      if (args.approved) {
        const access = await prisma.feishuUserAccess.findUnique({ where: { openId: approval.requesterOpenId } });
        if (!access || access.status !== 'pending') throw new Error('This access request is no longer pending.');
        const workspaceRoot = await resolveWorkspaceRoot(args.workspaceRoot || '');
        await ensureFeishuConversationBinding({
          context: { chatId: approval.requesterChatId, chatType: 'p2p', senderOpenId: approval.requesterOpenId, messageId: `approval:${approval.id}`, mentionNames: [] },
          allowDefaultAgent: true,
          workingDirectory: workspaceRoot,
          workspaceRoot,
          permissionConfig: { profile: 'safe_local', sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [workspaceRoot] },
        });
        await prisma.feishuUserAccess.update({ where: { openId: approval.requesterOpenId }, data: { workspaceRoot } });
      }
      const accessUpdated = await prisma.feishuUserAccess.updateMany({
        where: { openId: approval.requesterOpenId, status: 'pending' },
        data: { status: args.approved ? 'approved' : 'denied', decidedBy: args.actorOpenId, decidedAt: now },
      });
      if (accessUpdated.count !== 1) throw new Error('This access request is no longer pending.');
      responseText = args.approved ? '准入已批准，已创建受限 Safe Local 会话。请重新发送消息。' : '准入申请已被拒绝。';
    } else if (approval.kind === 'branch_switch') {
      const { resolveBranchSwitchApproval } = await import('@/lib/scheduled-jobs/project-branch');
      await prisma.feishuAdminApproval.update({ where: { id: approval.id }, data: { status: 'pending' } });
      responseText = await resolveBranchSwitchApproval({
        approvalId: approval.id,
        approved: args.approved,
        actorOpenId: args.actorOpenId || 'system',
      });
    } else if (args.approved && approval.payloadJson) {
      const stored = JSON.parse(approval.payloadJson) as StoredCommand;
      const { handleFeishuCommand } = await import('@/lib/feishu');
      responseText = await handleFeishuCommand({ ...stored, adminApproved: true });
    } else {
      responseText = 'Full Access 申请已被拒绝，原权限保持不变。';
    }
    await prisma.feishuAdminApproval.update({
      where: { id: approval.id },
      data: { status: args.approved ? 'approved' : 'denied' },
    });
  } catch (error) {
    await prisma.feishuAdminApproval.update({ where: { id: approval.id }, data: { status: 'pending', resolvedBy: null, resolvedAt: null } });
    throw error;
  }

  await sendFeishuTextMessage({ receiveId: approval.requesterChatId, receiveIdType: 'chat_id', text: responseText }).catch(() => {});

  if (args.cardMessageId) {
    await updateFeishuApprovalCardResolved({ messageId: args.cardMessageId, approved: args.approved, actorName: '管理员' }).catch(() => {});
  }
  return true;
}

type UserCommand = { command: string; args: string[]; options: Record<string, string> };

export async function handleFeishuUserManagementCommand(args: {
  command: UserCommand;
  senderOpenId: string | null | undefined;
  context?: FeishuConversationContext;
}) {
  if (!isFeishuAdmin(args.senderOpenId)) return '仅配置的 Feishu 管理员可以管理用户。';

  if (args.command.command === 'users') {
    const status = args.command.options.status?.trim().toLowerCase();
    const allowed = ['approved', 'pending', 'denied', 'revoked', 'blocked'];
    if (status && !allowed.includes(status)) return `无效状态：${status}`;
    if (args.context) return sendFeishuUserAdminCard(args.context, status);
    const users = await prisma.feishuUserAccess.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
    });
    return users.length ? users.map((user) => [
      user.displayName || fallbackDisplayName(user.openId),
      user.openId,
      user.status,
      user.workspaceRoot || '(未设置)',
      user.updatedAt.toISOString(),
    ].join(' | ')).join('\n') : '没有匹配的 Feishu 用户。';
  }

  const [action, openId] = args.command.args;
  if (!['approve', 'workspace', 'revoke', 'block', 'unblock'].includes(action || '') || !openId) {
    return '用法：/ap user approve <open_id> --workspace-root=/absolute/path | /ap user workspace <open_id> <absolute_root> | /ap user <revoke|block|unblock> <open_id>';
  }
  const user = await prisma.feishuUserAccess.findUnique({ where: { openId } });
  if (!user) return `找不到 Feishu 用户：${openId}`;
  if (action === 'workspace') {
    const workspaceRoot = await resolveWorkspaceRoot(args.command.args.slice(2).join(' ') || args.command.options['workspace-root'] || '');
    const bindings = await prisma.feishuConversationBinding.findMany({
      where: { OR: [{ senderOpenId: openId }, ...(user.chatId ? [{ chatId: user.chatId, chatType: 'p2p' }] : [])] },
      select: { liveRoomId: true },
    });
    await prisma.feishuUserAccess.update({ where: { openId }, data: { workspaceRoot, decidedBy: args.senderOpenId, decidedAt: new Date() } });
    for (const binding of bindings) {
      const room = await prisma.liveRoom.findUnique({ where: { id: binding.liveRoomId }, select: { workingDirectory: true, sourceTaskId: true, members: { select: { id: true } } } });
      if (!room) continue;
      let workingDirectory = room.workingDirectory;
      try { await resolveWorkspaceDirectory(workspaceRoot, workingDirectory || undefined); }
      catch { workingDirectory = workspaceRoot; }
      await prisma.liveRoom.update({ where: { id: binding.liveRoomId }, data: { workingDirectory } });
      if (room.sourceTaskId) await prisma.task.update({ where: { id: room.sourceTaskId }, data: { workingDirectory, acpxPermissionConfig: JSON.stringify({ profile: 'safe_local', sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [workspaceRoot] }) } });
      room.members.forEach((member) => interruptLiveRoomRunningProcess(member.id));
    }
    return `✅ ${user.displayName || fallbackDisplayName(openId)} 的授权根目录已更新为：${workspaceRoot}`;
  }
  if (action === 'approve') {
    if (user.status === 'blocked') return '该用户已被封禁，请先 unblock。';
    if (!user.chatId) return '该用户没有可用的 P2P chatId，无法批准。';
    const workspaceRoot = await resolveWorkspaceRoot(args.command.options['workspace-root'] || '');
    await ensureFeishuConversationBinding({
      context: { chatId: user.chatId, chatType: 'p2p', senderOpenId: openId, messageId: `admin:${Date.now()}`, mentionNames: [] },
      allowDefaultAgent: true,
      workingDirectory: workspaceRoot,
      workspaceRoot,
      permissionConfig: { profile: 'safe_local', sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [workspaceRoot] },
    });
    await prisma.feishuUserAccess.update({ where: { openId }, data: { workspaceRoot } });
  }
  const status = action === 'unblock' ? 'revoked' : action === 'approve' ? 'approved' : action === 'revoke' ? 'revoked' : 'blocked';
  await prisma.$transaction([
    prisma.feishuUserAccess.update({ where: { openId }, data: { status, decidedBy: args.senderOpenId, decidedAt: new Date() } }),
    prisma.feishuAdminApproval.updateMany({
      where: { requesterOpenId: openId, kind: 'user_pairing', status: 'pending' },
      data: { status: action === 'approve' ? 'approved' : 'denied', resolvedBy: args.senderOpenId, resolvedAt: new Date() },
    }),
  ]);
  return `✅ ${user.displayName || fallbackDisplayName(openId)} (${openId}) 已${action === 'approve' ? '批准' : action === 'revoke' ? '撤销' : action === 'block' ? '封禁' : '解除封禁'}。`;
}
