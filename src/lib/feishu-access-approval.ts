import { prisma } from '@/lib/prisma';
import { getFeishuUserDisplayName, sendFeishuInteractiveMessage, sendFeishuTextMessage, updateFeishuApprovalCardResolved } from '@/lib/feishu-api';
import { ensureFeishuConversationBinding } from '@/lib/feishu-live-room';

type StoredCommand = {
  command: Parameters<typeof import('@/lib/feishu').handleFeishuCommand>[0]['command'];
  baseUrl: string;
  context: NonNullable<Parameters<typeof import('@/lib/feishu').handleFeishuCommand>[0]['context']>;
};

const adminOpenId = () => process.env.FEISHU_ADMIN_OPEN_ID?.trim() || '';
const fallbackDisplayName = (openId: string) => `openid:...${openId.slice(-6)}`;

export const isFeishuAdmin = (openId: string | null | undefined) => !!openId && openId === adminOpenId();

async function sendAdminCard(args: { id: string; title: string; detail: string }) {
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
        { tag: 'action', actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '批准' }, value: { cmd: `admin-approval:approve:${args.id}` } },
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
  if (access?.status === 'approved') {
    const binding = await prisma.feishuConversationBinding.findFirst({
      where: { chatId: args.chatId, chatType: 'p2p', senderOpenId: args.senderOpenId },
    });
    return !!binding && access.chatId === args.chatId;
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

export async function requestFullAccessApproval(args: StoredCommand) {
  const existing = await prisma.feishuAdminApproval.findFirst({
    where: { requesterOpenId: args.context.senderOpenId, kind: 'full_access', status: 'pending', expiresAt: { gt: new Date() } },
  });
  if (existing) return '已有待处理的 Full Access 申请，请等待管理员审批。';

  const storedArgs: StoredCommand = args.command.command === 'rights'
    ? { ...args, command: { command: 'grant', args: ['full'], options: { ...args.command.options } } }
    : args;
  const approval = await prisma.feishuAdminApproval.create({
    data: {
      kind: 'full_access',
      requesterOpenId: args.context.senderOpenId,
      requesterChatId: args.context.chatId,
      payloadJson: JSON.stringify(storedArgs),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await sendAdminCard({
    id: approval.id,
    title: 'Full Access 审批',
    detail: `申请人：\`${args.context.senderOpenId}\`\n命令：\`${args.command.command} ${args.command.args.join(' ')}\`\n15 分钟内有效。`,
  });
  return 'Full Access 申请已发送给管理员；批准前不会修改权限或启动运行。';
}

export async function resolveFeishuAdminApproval(args: {
  approvalId: string;
  approved: boolean;
  actorOpenId: string | null | undefined;
  cardMessageId?: string;
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
        await ensureFeishuConversationBinding({
          context: { chatId: approval.requesterChatId, chatType: 'p2p', senderOpenId: approval.requesterOpenId, messageId: `approval:${approval.id}`, mentionNames: [] },
          allowDefaultAgent: true,
        });
      }
      const accessUpdated = await prisma.feishuUserAccess.updateMany({
        where: { openId: approval.requesterOpenId, status: 'pending' },
        data: { status: args.approved ? 'approved' : 'denied', decidedBy: args.actorOpenId, decidedAt: now },
      });
      if (accessUpdated.count !== 1) throw new Error('This access request is no longer pending.');
      responseText = args.approved ? '准入已批准，已创建默认 Safe Local 会话。请重新发送消息。' : '准入申请已被拒绝。';
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
}) {
  if (!isFeishuAdmin(args.senderOpenId)) return '仅配置的 Feishu 管理员可以管理用户。';

  if (args.command.command === 'users') {
    const status = args.command.options.status?.trim().toLowerCase();
    const allowed = ['approved', 'pending', 'denied', 'revoked', 'blocked'];
    if (status && !allowed.includes(status)) return `无效状态：${status}`;
    const users = await prisma.feishuUserAccess.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
    });
    return users.length ? users.map((user) => [
      user.displayName || fallbackDisplayName(user.openId),
      user.openId,
      user.status,
      user.updatedAt.toISOString(),
    ].join(' | ')).join('\n') : '没有匹配的 Feishu 用户。';
  }

  const [action, openId] = args.command.args;
  if (!['approve', 'revoke', 'block', 'unblock'].includes(action || '') || !openId) {
    return '用法：/ap user <approve|revoke|block|unblock> <open_id>';
  }
  const user = await prisma.feishuUserAccess.findUnique({ where: { openId } });
  if (!user) return `找不到 Feishu 用户：${openId}`;
  if (action === 'approve') {
    if (user.status === 'blocked') return '该用户已被封禁，请先 unblock。';
    if (!user.chatId) return '该用户没有可用的 P2P chatId，无法批准。';
    await ensureFeishuConversationBinding({
      context: { chatId: user.chatId, chatType: 'p2p', senderOpenId: openId, messageId: `admin:${Date.now()}`, mentionNames: [] },
      allowDefaultAgent: true,
    });
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
