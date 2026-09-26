import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prisma } from '@/lib/prisma';
import {
  ensureFeishuConversationBinding,
  getBoundLiveRoom,
  getBoundLiveRoomId,
  getBoundSourceTaskId,
  resolveFeishuSelectedAgentIds,
  resolveRoomMemberQuery,
  postFeishuMessageToBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { listPendingTaskRunInteractionRequests } from '@/lib/acpx/interactions';
import { resolveInteractionRequestWithContinuation } from '@/lib/acpx/interaction-actions';
import { createGrantActionToken, grantRightsForRoom, parseGrantProfile } from '@/lib/feishu-grant';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { resolveWorkspaceDirectory, resolveWorkspaceRoot } from '@/lib/feishu-workspace';
import { buildTaskRoomPromptContext } from '@/lib/task-room';
import {
  listLiveRoomPendingReplies,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';

const resolveLiveRoomMemberByQuery = <T extends {
  id: string;
  memberType: string;
  displayName: string;
  userNickname?: string | null;
  shortAlias?: string | null;
}>(
  members: T[],
  query: string
) => {
  const normalizedQuery = query.trim().replace(/^[@$]/, '').toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  return members.find((member) =>
    member.memberType !== 'user' && (
      `${member.displayName} [${member.id.slice(-8)}]`.toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase() === normalizedQuery ||
      (member.userNickname || '').toLowerCase() === normalizedQuery ||
      (member.shortAlias || '').toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase().includes(normalizedQuery) ||
      member.id.endsWith(normalizedQuery)
    )
  ) || null;
};

export async function handleChatCommand(
  command: ParsedFeishuCommand,
  baseUrl: string,
  context?: FeishuConversationContext
) {
  const fromGatewayId = command.options['from'];
  const toGatewayId = command.options['to'];
  const prompt = command.args.join(' ').trim();

  if (fromGatewayId || toGatewayId) {
    if (!fromGatewayId || !toGatewayId || !prompt) {
      return [
        'chat 命令参数不足。',
        '示例：',
        '/ap chat --from=<gatewayId> --to=<gatewayId> --from-agent=main --to-agent=main --turns=2 请讨论一下当前需求',
      ].join('\n');
    }

    const response = await fetch(new URL('/api/gateways/chat', baseUrl).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromGatewayId,
        toGatewayId,
        fromAgentId: command.options['from-agent'] || 'main',
        toAgentId: command.options['to-agent'] || 'main',
        turns: command.options['turns'] === '1' ? 1 : 2,
        prompt,
      }),
    });

    const data = (await response.json()) as {
      error?: string;
      messages?: Array<{
        gatewayId: string | null;
        agentId: string | null;
        text: string;
      }>;
    };

    if (!response.ok) {
      throw new Error(data.error || 'Failed to run cross-gateway chat');
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const transcript = messages
      .map((message) => {
        const speaker = message.gatewayId || 'user';
        const agent = message.agentId ? ` / ${message.agentId}` : '';
        return `${speaker}${agent}\n${message.text}`;
      })
      .join('\n\n');

    return ['Cross-gateway chat 已完成', transcript || '(空回复)'].join('\n\n');
  }

  if (!context) {
    return '当前 chat 模式需要来自 Feishu webhook 的会话上下文。';
  }

  if (!prompt) {
    return [
      'chat 命令参数不足。',
      '示例：',
      '/ap chat --agents=<agentId1,agentId2> 先建立一个房间并开始讨论',
      '/ap chat --from-member=codex --to-member=claude 请确认远端状态',
      '/ap chat 继续讨论这个问题',
    ].join('\n');
  }

  const selectedAgentIds = await resolveFeishuSelectedAgentIds(command.options['agents']);
  const binding = await ensureFeishuConversationBinding({
    context,
    selectedAgentIds,
    title: command.options['title'],
    topic: command.options['topic'],
  });

  const fromMemberQuery = (command.options['from-member'] || '').trim();
  const toMemberQuery = (command.options['to-member'] || '').trim();
  if (fromMemberQuery || toMemberQuery) {
    if (!fromMemberQuery || !toMemberQuery) {
      return [
        '定向 chat 需要同时指定 from-member 和 to-member。',
        '示例：',
        '/ap chat --from-member=codex --to-member=claude 请确认远端状态',
      ].join('\n');
    }

    const roomMembers = await prisma.liveRoomMember.findMany({
      where: { roomId: binding.liveRoomId },
      orderBy: { sortOrder: 'asc' },
    });
    const fromMember = resolveLiveRoomMemberByQuery(roomMembers, fromMemberQuery);
    const toMember = resolveLiveRoomMemberByQuery(roomMembers, toMemberQuery);

    if (!fromMember) {
      const names = roomMembers
        .filter((member) => member.memberType !== 'user')
        .map((member) => `${member.userNickname || member.displayName} [${member.id.slice(-8)}]`)
        .join(', ');
      return `找不到 from-member：${fromMemberQuery}\n当前成员：${names || '(none)'}`;
    }

    if (!toMember) {
      const names = roomMembers
        .filter((member) => member.memberType !== 'user')
        .map((member) => `${member.userNickname || member.displayName} [${member.id.slice(-8)}]`)
        .join(', ');
      return `找不到 to-member：${toMemberQuery}\n当前成员：${names || '(none)'}`;
    }

    if (!toMember.canReply) {
      return `${toMember.userNickname || toMember.displayName} 当前不可回复，不能作为定向消息目标。`;
    }

    const message = await postLiveRoomMessage({
      roomId: binding.liveRoomId,
      senderMemberId: fromMember.id,
      content: prompt,
      messageType: 'assistant',
      visibility: 'directed_visible',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'assistant',
        targetMemberId: toMember.id,
        visibilityMode: 'directed_visible',
        extras: {
          targetMemberName: toMember.userNickname || toMember.displayName,
          source: 'feishu_directed_chat_command',
          targetResolutionSource: 'feishu_chat_from_to_member',
        },
      }),
    });

    await triggerLiveRoomMessageReplies({
      roomId: binding.liveRoomId,
      roomMessageId: message.id,
      requestedTargetMemberId: toMember.id,
    });

    const pendingReplies = await listLiveRoomPendingReplies(binding.liveRoomId);
    return [
      `消息已写入 Live Room ${binding.liveRoomId}`,
      `定向可见通信：${fromMember.userNickname || fromMember.displayName} -> ${toMember.userNickname || toMember.displayName}`,
      pendingReplies.length > 0
        ? `房间待回复成员：${pendingReplies.map((reply) => reply.displayName).join(', ')}`
        : '当前没有待回复成员。',
    ].join('\n');
  }

  const result = await postFeishuMessageToBoundLiveRoom({
    context,
    content: prompt,
  });

  const targetedNames = result.targetedMembers.map((member) => member.displayName).join(', ');
  const pendingReplyNames = result.pendingReplies.map((reply) => reply.displayName).join(', ');
  return [
    `消息已写入 Live Room ${result.liveRoomId}`,
    result.mentionedAll
      ? '本条消息目标：全部房间成员'
      : result.targetedMembers.length > 0
      ? `本条消息目标：${targetedNames}`
      : '本条消息目标：未指定，按当前房间路由处理',
    result.pendingReplies.length > 0
      ? `房间待回复成员：${pendingReplyNames}`
      : '当前没有待回复成员。若需要触发指定 agent，请在消息里 @房间成员名称。',
  ].join('\n');
}

export async function handleGrantCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext, fullAccessApproved = false) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法授权。';
  }

  const profile =
    parseGrantProfile(command.options['profile'])
    || parseGrantProfile(command.args[0])
    || null;
  if (!profile) {
    return [
      '请指定授权档位。',
      '示例：/ap grant full',
      '示例：/ap grant dev --agent=codex',
      '说明：这会立刻更新当前 task session 的有效权限，并用于随后的 continuation；不会原地热切换已经卡住的旧进程 stdin。',
    ].join('\n');
  }

  const consumedFirstArg = !command.options['profile'] && parseGrantProfile(command.args[0]);
  const message = command.args.slice(consumedFirstArg ? 1 : 0).join(' ').trim();
  const memberQuery = (command.options['agent'] || '').trim() || null;
  const result = await grantRightsForRoom({
    roomId,
    profile,
    memberQuery,
    message,
    fullAccessApproved,
  });

  return [
    `✅ 已授予 ${result.member.userNickname || result.member.displayName} ${profile === 'full_access' ? '完全权限' : '开发权限'}`,
    `Task: ${result.room.sourceTask!.name}`,
    `运行方式：${result.usedContinuation ? '继续原会话' : '启动新 run'}`,
    `新 run：${result.taskRunId}`,
    '说明：权限已写入当前 task session，并已用于这次 continuation / run；不会原地热切换旧进程。',
  ].join('\n');
}

export async function handleRightsCommand(args: {
  command: ParsedFeishuCommand;
  baseUrl: string;
  context?: FeishuConversationContext;
}) {
  if (!args.context) {
    return '当前 rights 命令需要来自 Feishu webhook 的会话上下文。';
  }

  const room = await getBoundLiveRoom(args.context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法发送授权卡片。';
  }

  const memberQuery = (args.command.options['agent'] || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) {
    return memberQuery
      ? `找不到目标成员：${memberQuery}`
      : '当前房间没有可授权的 agent 成员。';
  }

  const buildActionUrl = (profile: 'dev_local' | 'full_access') => {
    const token = createGrantActionToken({
      roomId: room.id,
      memberId: member.id,
      profile,
    });
    return new URL(`/api/feishu/grant?token=${encodeURIComponent(token)}`, args.baseUrl).toString();
  };

  await sendFeishuInteractiveMessage({
    receiveId: args.context.chatId,
    receiveIdType: 'chat_id',
    replyId: args.context.messageId,
    card: {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'orange',
        title: {
          tag: 'plain_text',
          content: `给 ${member.userNickname || member.displayName} 授权`,
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: [
            `**Task**: ${room.sourceTask.name}`,
            '点击按钮后会立刻更新当前 task session 的有效权限，并自动 continuation 或启动新的 run。',
            '说明：不会直接把许可写回已经阻塞中的旧进程 stdin。',
          ].join('\n'),
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '授予开发权限并继续',
              },
              type: 'primary',
              url: buildActionUrl('dev_local'),
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '授予完全权限并继续',
              },
              type: 'danger',
              url: buildActionUrl('full_access'),
            },
          ],
        },
      ],
    },
  });

  return `✅ 已发送授权卡片给当前 Feishu 会话，可直接点击按钮给 ${member.userNickname || member.displayName} 授权。`;
}

function sanitizeHandoverSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'handover';
}

function buildHandoverDocBody(args: {
  roomTitle: string;
  memberName: string;
  taskName: string;
  latestUserMessage: string | null;
  transcript: string;
  title: string;
}) {
  return [
    `# ${args.title}`,
    '',
    '## 当前目标',
    args.latestUserMessage || `继续处理 Live Room "${args.roomTitle}" 中分配给 ${args.memberName} 的任务。`,
    '',
    '## 已完成',
    '- 已生成这份 handover 文档。',
    '- 当前 room / task 上下文已整理到本文档中。',
    '',
    '## 未完成',
    '- 需要新 session 继续阅读 handover 并执行下一步。',
    '',
    '## 风险/阻塞',
    '- 旧 session 上下文可能不完整或已接近上限。',
    '- 若涉及 git add / commit，请确认当前执行环境的 `.git` 可写。',
    '',
    '## 下一步',
    `- 先阅读本文档，再继续处理 ${args.memberName} 的当前任务。`,
    '- 复述当前状态。',
    '- 执行最直接的下一步，并在必要时回写新的 handover。',
    '',
    '## 相关文件',
    `- Task: ${args.taskName}`,
    '- 相关仓库：/data1/code/agent-platform-v2',
    '',
    '## 验证状态',
    '- 本文档由 Feishu `/ap handover` 自动生成。',
    '',
    '## Task Room 摘要',
    args.transcript || '(当前没有可用的非系统 task room transcript)',
    '',
  ].join('\n');
}

export async function handleHandoverCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法生成 handover。';
  }

  const memberQuery = (command.options['agent'] || command.args.join(' ') || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) {
    return memberQuery
      ? `找不到可交接成员：${memberQuery}`
      : '当前房间没有可交接的 agent 成员。';
  }

  const promptContext = await buildTaskRoomPromptContext(room.sourceTask.id, room.sourceTask.name, 30);
  const title =
    (command.options['title'] || '').trim()
    || `${room.title} ${member.userNickname || member.displayName} handover`;
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `${timestamp}_${sanitizeHandoverSlug(title)}_HANDOVER.md`;
  const relativePath = path.posix.join('docs', fileName);
  const absolutePath = path.join(process.cwd(), relativePath);
  const body = buildHandoverDocBody({
    roomTitle: room.title,
    memberName: member.userNickname || member.displayName,
    taskName: room.sourceTask.name,
    latestUserMessage: promptContext.latestUserMessage?.content || null,
    transcript: promptContext.transcript,
    title,
  });

  await fs.writeFile(absolutePath, body, 'utf8');

  return [
    `✅ 已为 ${member.userNickname || member.displayName} 生成 handover`,
    `文件：${relativePath}`,
    '',
    '下一步可发送：',
    `/ap new --handover="${relativePath}" --profile=full "${member.userNickname || member.displayName}"`,
  ].join('\n');
}

async function findPendingInteractionRequestForTask(taskId: string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const requests = await listPendingTaskRunInteractionRequests({ taskId });
  return requests.find((request) =>
    request.id.toLowerCase() === normalized
    || request.id.slice(-8).toLowerCase() === normalized
  ) || null;
}

export async function handleApprovalsCommand(context?: FeishuConversationContext) {
  const taskId = await getBoundSourceTaskId(context);
  if (!taskId) {
    return '当前 Feishu 会话未绑定可继续的 task 上下文，无法查看 pending approvals。';
  }

  const requests = await listPendingTaskRunInteractionRequests({ taskId });
  if (requests.length === 0) {
    return '当前没有 pending approvals。';
  }

  const lines = requests.slice(0, 10).map((request) => {
    const shortId = request.id.slice(-8);
    return `- ${shortId} | ${request.requestKind} | ${request.message}`;
  });

  return [
    'Pending approvals',
    ...lines,
    '',
    '处理示例：',
    '/ap approve <id>',
    '/ap deny <id> 原因',
    '/ap answer <id> 你的回复',
  ].join('\n');
}

export async function handleApproveLikeCommand(args: {
  command: ParsedFeishuCommand;
  context?: FeishuConversationContext;
  action: 'approve' | 'deny' | 'answer';
}) {
  const taskId = await getBoundSourceTaskId(args.context);
  if (!taskId) {
    return '当前 Feishu 会话未绑定可继续的 task 上下文，无法处理 approval。';
  }

  const requestQuery = (args.command.args[0] || '').trim();
  if (!requestQuery) {
    return args.action === 'approve'
      ? '请指定 approval id。\n示例：/ap approve abc12345'
      : args.action === 'deny'
      ? '请指定 approval id。\n示例：/ap deny abc12345 不允许联网'
      : '请指定 approval id 和回复内容。\n示例：/ap answer abc12345 staging';
  }

  const responseText = args.command.args.slice(1).join(' ').trim() || null;
  if (args.action === 'answer' && !responseText) {
    return '请提供 answer 内容。\n示例：/ap answer abc12345 staging';
  }

  const request = await findPendingInteractionRequestForTask(taskId, requestQuery);
  if (!request) {
    return `找不到 pending approval：${requestQuery}\n可先使用 /ap approvals 查看当前列表。`;
  }

  const result = await resolveInteractionRequestWithContinuation({
    requestId: request.id,
    action: args.action,
    responseText,
    actor: {
      id: args.context?.senderOpenId || 'feishu-user',
      name: 'Feishu User',
      channel: 'feishu',
    },
  });

  return [
    `✅ approval ${request.id.slice(-8)} 已${args.action === 'deny' ? '拒绝' : '处理'}`,
    `类型：${request.requestKind}`,
    `状态：${result.status}`,
    result.resumed
      ? `已继续会话，新的 run：${result.continuationRunId}`
      : result.resumeError
      ? `未自动继续：${result.resumeError}`
      : '当前未自动继续会话。',
  ].join('\n');
}

export async function handleWorkspaceCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  if (!context?.senderOpenId) return '无法识别当前 Feishu 用户。';
  const isAdmin = isFeishuAdmin(context.senderOpenId);
  const access = await prisma.feishuUserAccess.findUnique({ where: { openId: context.senderOpenId }, select: { workspaceRoot: true } });
  if (!isAdmin && !access?.workspaceRoot) return '当前用户尚未配置授权根目录，请联系管理员。';
  const workspaceRoot = access?.workspaceRoot;
  const newDir = command.args.join(' ').trim() || command.options['path'] || '';
  if (!newDir) {
    const room = await prisma.liveRoom.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        title: true,
        workingDirectory: true,
        sourceTask: { select: { workingDirectory: true } },
      },
    });
    if (!room) return '当前 Feishu 会话绑定的 Live Room 不存在。';
    const actualWorkdir = room.workingDirectory || room.sourceTask?.workingDirectory || process.cwd();
    return [
      `Room：${room.title} (${room.id})`,
      `绑定会话：${context.chatType} ${context.chatId}`,
      `授权根目录：${isAdmin ? '管理员不受用户根目录限制' : workspaceRoot}`,
      `Room workdir：${room.workingDirectory || '(未设置)'}`,
      `实际 workdir：${actualWorkdir}${room.workingDirectory ? '' : '（回退值，非群独占 workspace）'}`,
      isAdmin ? '如需修改：/ap workspace <绝对目录路径>' : '如需修改：/ap workspace <授权根目录内路径>',
    ].join('\n');
  }

  const resolvedDir = isAdmin
    ? await resolveWorkspaceRoot(newDir)
    : await resolveWorkspaceDirectory(workspaceRoot!, newDir);

  await prisma.$executeRaw`
    UPDATE "LiveRoom"
    SET "workingDirectory" = ${resolvedDir}
    WHERE "id" = ${roomId}
  `;
  const room = await prisma.liveRoom.findUnique({ where: { id: roomId }, select: { sourceTaskId: true } });
  if (room?.sourceTaskId) {
    await prisma.task.update({ where: { id: room.sourceTaskId }, data: { workingDirectory: resolvedDir } });
  }

  return `✅ 工作目录已更新为：${resolvedDir}`;
}
