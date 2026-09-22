import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';
import {
  ARCHIVED_FEISHU_TASK_HINT,
  ensureFeishuConversationBinding,
  getBoundLiveRoom,
  getBoundLiveRoomId,
  hasFeishuTopicIdentity,
  resolveFeishuConversationTarget,
  resolveFeishuSelectedAgentIds,
  resolveDefaultFeishuBindingAgentIds,
  resolveRoomMemberQuery,
  setFeishuBoundRoomMode,
  UNKNOWN_FEISHU_TOPIC_HINT,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { parseLiveRoomMode } from '@/lib/live-room-scheduling';
import { normalizeCodexMemberSettings } from '@/lib/live-room-codex-settings';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import {
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomMembersWithContext,
} from '@/lib/live-room';
import { parseNewSessionProfile } from '@/lib/feishu-new-session';
import { buildAcpxPermissionConfigForProfile } from '@/lib/acpx/permissions';
import { formatLiveRoomPermissionLabel } from '@/lib/live-room-permissions';
import {
  DEFAULT_LIVE_ROOM_HANDOFF_LIMIT,
  MAX_LIVE_ROOM_HANDOFF_LIMIT,
  parseLiveRoomHandoffLimit,
} from '@/lib/live-room-handoff';
import {
  MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES,
  liveRoomTimeoutMinutesToMs,
  liveRoomTimeoutMsToMinutes,
  parseLiveRoomExecutionTimeoutInput,
} from '@/lib/live-room-execution-timeout';

export const formatLiveRoomExecutionTimeoutMinutes = (executionTimeoutMs: number | null) =>
  executionTimeoutMs === null
    ? '继承默认（远程 10 分钟 / Platform Local 长任务不限时）'
    : `${liveRoomTimeoutMsToMinutes(executionTimeoutMs)} 分钟`;

/** Shared validation + update path for the room execution timeout.
 *  Used by both the /ap room --timeout=<分钟> entry and the /ap timeout <分钟> shortcut. */
export const applyLiveRoomExecutionTimeoutUpdate = async ({
  roomId,
  requestedValue,
  changedBy,
}: {
  roomId: string;
  requestedValue: string | number | undefined;
  changedBy?: string | null;
}): Promise<{ ok: true; minutes: number | null } | { ok: false; error: string }> => {
  const parsed = parseLiveRoomExecutionTimeoutInput(requestedValue);
  if (parsed.kind === 'invalid') {
    return {
      ok: false,
      error: `无效执行超时。请输入 1-${MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES} 的整数分钟，或 inherit 恢复默认。`,
    };
  }

  const previous = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { executionTimeoutMs: true },
  });
  const executionTimeoutMs = parsed.kind === 'minutes' ? liveRoomTimeoutMinutesToMs(parsed.minutes) : null;
  await prisma.liveRoom.update({
    where: { id: roomId },
    data: { executionTimeoutMs },
  });
  await postLiveRoomMessage({
    roomId,
    content: `系统提示：执行超时已从 ${formatLiveRoomExecutionTimeoutMinutes(previous?.executionTimeoutMs ?? null)} 调整为 ${formatLiveRoomExecutionTimeoutMinutes(executionTimeoutMs)}。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        systemEvent: 'execution_timeout_changed',
        previousExecutionTimeoutMs: previous?.executionTimeoutMs ?? null,
        executionTimeoutMs,
        changedBy: changedBy || null,
      },
    }),
  });
  return { ok: true, minutes: parsed.kind === 'minutes' ? parsed.minutes : null };
};

export async function handleMembersCommand(context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。请先使用 /ap room --agents=<agentId> 创建绑定。';
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      sourceTask: {
        select: {
          id: true,
          name: true,
          acpxPermissionConfig: true,
        },
      },
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!room || room.members.length === 0) {
    return `Live Room ${roomId} 没有成员。`;
  }

  const members = await serializeLiveRoomMembersWithContext({
    members: room.members,
    sourceTask: room.sourceTask,
  });

  const lines = members.map((m) => {
    const tag = m.memberType === 'user' ? '(you)' : m.presenceStatus;
    const watermark = m.contextWatermark
      ? m.contextWatermark.usagePercentage == null
        ? m.contextWatermark.source === 'not_applicable'
          ? m.contextWatermark.usedTokens
            ? ` | 上下文 每轮新 conversation (单次输入: ${m.contextWatermark.usedTokens.toLocaleString()} tokens${m.contextWatermark.contextWindow ? ` / ${m.contextWatermark.contextWindow.toLocaleString()} max, ${Math.round(m.contextWatermark.usedTokens / m.contextWatermark.contextWindow * 100)}%` : ''}) | 策略 ${m.contextWatermark.policyLabel}`
            : ` | 上下文 每轮新 conversation (${m.contextWatermark.dominantLabel}) | 策略 ${m.contextWatermark.policyLabel}`
          : ` | 上下文 暂无 provider 遥测 (${m.contextWatermark.dominantLabel}) | 策略 ${m.contextWatermark.policyLabel}`
        : ` | 用量 ${m.contextWatermark.usagePercentage}% (${m.contextWatermark.dominantLabel}) | 策略 ${m.contextWatermark.policyLabel}`
      : '';
    const permission = m.permissionLabel ? ` | ${m.permissionLabel}` : '';
    const role = ` | 角色: ${m.role || 'custom'}`;
    return `- ${m.displayName} [${m.id.slice(-8)}]${role} | ${m.backend || 'local'}${permission} | ${tag}${watermark}`;
  });

  return [`Live Room 成员列表 (${roomId.slice(-8)})`, ...lines].join('\n');
}

export async function handleNickCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const memberQuery = (command.options['member'] || command.args[0] || '').trim().replace(/^[@$]/, '');
  const nickname = (command.options['name'] || command.args.slice(1).join(' ') || '').trim();

  if (!memberQuery || !nickname) {
    return [
      '请指定成员和新昵称。',
      '示例：/ap nick --member="hk-vision Claude" --name="hk-vision"',
      '示例：/ap nick claude local-claude',
    ].join('\n');
  }

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    include: {
      gateway: true,
    },
    orderBy: { sortOrder: 'asc' },
  });

  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === memberQuery.toLowerCase() ||
      m.displayName.toLowerCase() === memberQuery.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === memberQuery.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === memberQuery.toLowerCase() ||
      m.displayName.toLowerCase().includes(memberQuery.toLowerCase()) ||
      m.id.endsWith(memberQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => `${m.displayName} [${m.id.slice(-8)}]`)
      .join(', ');
    return `找不到成员：${memberQuery}\n当前成员：${names || '(none)'}`;
  }

  const shortAlias = generateShortAlias(
    nickname,
    target.harnessType || 'unknown',
    target.gateway?.name || null,
    target.backend
  );

  const conflictingMemberIds = members
    .filter((member) => member.id !== target.id && member.userNickname?.toLowerCase() === nickname.toLowerCase())
    .map((member) => member.id);
  const updated = await prisma.$transaction(async (tx) => {
    if (conflictingMemberIds.length > 0) {
      await tx.liveRoomMember.updateMany({
        where: { id: { in: conflictingMemberIds }, roomId },
        data: { userNickname: null },
      });
    }
    return tx.liveRoomMember.update({
      where: { id: target.id },
      data: {
        userNickname: nickname,
        shortAlias,
      },
    });
  });

  return `✅ 已将 ${target.displayName} 重命名为 ${updated.userNickname}。\n后续可直接使用 $${updated.userNickname} 进行 mention。`;
}

export async function handleRoleCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const memberQuery = (command.options['member'] || command.args[0] || '').trim().replace(/^[@$]/, '');
  const requestedRole = (command.options['role'] || command.args[1] || '').trim().toLowerCase();
  const role = requestedRole === 'implementor' ? 'implementer' : requestedRole;
  const validRoles = ['planner', 'researcher', 'implementer', 'reviewer', 'tester', 'custom'];
  if (!memberQuery || !validRoles.includes(role)) {
    return [
      '请指定成员和有效角色。',
      '角色：planner、researcher、implementer、reviewer、tester、custom',
      '示例：/ap role --member=lcc --role=implementer',
    ].join('\n');
  }

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    orderBy: { sortOrder: 'asc' },
  });
  const normalizedQuery = memberQuery.toLowerCase();
  const target = members.find((member) =>
    member.memberType !== 'user' && (
      member.displayName.toLowerCase() === normalizedQuery ||
      (member.userNickname || '').toLowerCase() === normalizedQuery ||
      (member.shortAlias || '').toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase().includes(normalizedQuery) ||
      member.id.endsWith(memberQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((member) => member.memberType !== 'user')
      .map((member) => member.userNickname || member.displayName)
      .join(', ');
    return `找不到成员：${memberQuery}\n当前成员：${names || '(none)'}`;
  }

  await prisma.liveRoomMember.update({
    where: { id: target.id },
    data: { role },
  });
  return `✅ 已将 ${target.userNickname || target.displayName} 的角色设为 ${role}。`;
}

export async function handleSpecialtyCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const memberQuery = (command.options['member'] || command.args[0] || '').trim().replace(/^[@$]/, '');
  const specialty = (command.options['specialty'] || command.args[1] || '').trim().toLowerCase();
  const validSpecialties = ['documentation', 'diagnostics', 'implementation', 'general'];
  if (!memberQuery || !validSpecialties.includes(specialty)) {
    return [
      '请指定成员和有效职责。',
      '职责：documentation、diagnostics、implementation、general',
      '示例：/ap specialty --member=lcc --specialty=documentation',
    ].join('\n');
  }

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    orderBy: { sortOrder: 'asc' },
  });
  const normalizedQuery = memberQuery.toLowerCase();
  const target = members.find((member) =>
    member.memberType !== 'user' && (
      member.displayName.toLowerCase() === normalizedQuery ||
      (member.userNickname || '').toLowerCase() === normalizedQuery ||
      (member.shortAlias || '').toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase().includes(normalizedQuery) ||
      member.id.endsWith(memberQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((member) => member.memberType !== 'user')
      .map((member) => member.userNickname || member.displayName)
      .join(', ');
    return `找不到成员：${memberQuery}\n当前成员：${names || '(none)'}`;
  }

  await prisma.liveRoomMember.update({
    where: { id: target.id },
    data: { specialty },
  });
  return `✅ 已将 ${target.userNickname || target.displayName} 的职责设为 ${specialty}。`;
}

export async function handleCodexConfigCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room) return '当前 Feishu 会话尚未绑定 Live Room。';

  const memberQuery = (command.options['agent'] || command.options['member'] || command.args[0] || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) return memberQuery ? `找不到目标成员：${memberQuery}` : '当前房间没有可配置的 agent 成员。';
  if (member.harnessType !== 'codex') return `${member.userNickname || member.displayName} 不是 Codex 成员。`;

  const hasModel = 'model' in command.options;
  const hasThinking = 'thinking' in command.options || 'reasoning' in command.options;
  if (!hasModel && !hasThinking) {
    return [
      `${member.userNickname || member.displayName} Codex 配置`,
      `Model: ${member.codexModel || 'inherit'}`,
      `Thinking: ${member.codexReasoningEffort || 'inherit'}`,
    ].join('\n');
  }

  const requestedModel = command.options['model'];
  const requestedThinking = command.options['thinking'] ?? command.options['reasoning'];
  const settings = normalizeCodexMemberSettings({
    model: hasModel && requestedModel !== 'inherit' ? requestedModel : member.codexModel,
    reasoningEffort: hasThinking && requestedThinking !== 'inherit'
      ? requestedThinking
      : member.codexReasoningEffort,
  });
  if (hasModel && requestedModel === 'inherit') settings.model = null;
  if (hasThinking && requestedThinking === 'inherit') settings.reasoningEffort = null;

  const updated = await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: {
      codexModel: settings.model,
      codexReasoningEffort: settings.reasoningEffort,
    },
  });

  return [
    `✅ 已更新 ${updated.userNickname || updated.displayName} 的 Codex 配置`,
    `Model: ${updated.codexModel || 'inherit'}`,
    `Thinking: ${updated.codexReasoningEffort || 'inherit'}`,
    '将在下一次 run / continuation 生效。',
  ].join('\n');
}

export async function handleSpeakerCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { currentSpeakerMemberId: true },
  });

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    orderBy: { sortOrder: 'asc' },
  });

  const query = (command.options['member'] || command.args.join(' ') || '').trim().replace(/^[@$]/, '');
  if (!query) {
    const current = members.find((member) => member.id === room?.currentSpeakerMemberId) || null;
    return current
      ? `当前默认 speaker：${current.userNickname || current.displayName} [${current.id.slice(-8)}]`
      : '当前房间还没有默认 speaker。';
  }

  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === query.toLowerCase() ||
      m.displayName.toLowerCase() === query.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === query.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === query.toLowerCase() ||
      m.displayName.toLowerCase().includes(query.toLowerCase()) ||
      m.id.endsWith(query)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => `${m.userNickname || m.displayName} [${m.id.slice(-8)}]`)
      .join(', ');
    return `找不到成员：${query}\n当前可切换 speaker 的成员：${names || '(none)'}`;
  }

  await prisma.liveRoom.update({
    where: { id: roomId },
    data: {
      currentSpeakerMemberId: target.id,
    },
  });

  return `✅ 默认 speaker 已切换为 ${target.userNickname || target.displayName} [${target.id.slice(-8)}]`;
}

export async function handleKickCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const nameQuery = command.args.join(' ').trim().replace(/^@/, '');
  if (!nameQuery) {
    return '请指定要移除的成员名称。\n示例：/ap kick claude';
  }

  const members = await prisma.liveRoomMember.findMany({ where: { roomId } });
  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === nameQuery.toLowerCase() ||
      m.displayName.toLowerCase() === nameQuery.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === nameQuery.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === nameQuery.toLowerCase() ||
      m.displayName.toLowerCase().includes(nameQuery.toLowerCase()) ||
      m.id.endsWith(nameQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => m.userNickname || m.displayName)
      .join(', ');
    return `找不到成员：${nameQuery}\n当前可踢出的成员：${names || '(none)'}`;
  }

  await fetch(new URL(
    `/api/live-rooms/${roomId}/members/${target.id}`,
    process.env.AGENT_PLATFORM_BASE_URL?.trim() || 'http://127.0.0.1:3010'
  ).toString(), { method: 'DELETE' });

  return `✅ 已将 ${target.displayName} 从房间移除。`;
}

export async function handleAddCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const agentSelectorValue = command.options['agents'] || command.args.join(',');
  const agentIds = await resolveFeishuSelectedAgentIds(agentSelectorValue);

  if (agentIds.length === 0) {
    return '请指定要添加的 agent。\n示例：/ap add --agents=TX-server:claude\n也支持完整 agent ID。';
  }

  // Re-use the existing room binding add path
  const { ensureFeishuConversationBinding } = await import('@/lib/feishu-live-room');
  if (!context) return '需要 Feishu 会话上下文。';
  const result = await ensureFeishuConversationBinding({ context, selectedAgentIds: agentIds });
  return `✅ 已添加 ${result.addedAgentCount} 个成员到 Live Room ${result.liveRoomId.slice(-8)}。\n可使用 /ap members 查看当前成员列表。`;
}

export async function handleRoomCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  if (!context) {
    return '当前 room 命令需要来自 Feishu webhook 的会话上下文。';
  }

  // Group-level bindings are managed from the group root only. Inside a topic
  // thread the room command must not create or mutate the group binding: reuse
  // is limited to the bound task room, and unknown/archived topics are rejected.
  if (hasFeishuTopicIdentity(context)) {
    const target = await resolveFeishuConversationTarget(context);
    if (target.kind !== 'task' || !target.binding) {
      return target.kind === 'archived_task' ? ARCHIVED_FEISHU_TASK_HINT : UNKNOWN_FEISHU_TOPIC_HINT;
    }
    const binding = target.binding;
    const room = await prisma.liveRoom.findUnique({
      where: { id: binding.liveRoomId },
      select: { title: true },
    });
    return [
      `该话题已绑定任务房间：${room?.title || binding.liveRoomId}`,
      '话题内请使用 /ap add 调整成员、/ap members 查看房间；',
      '新的任务创建入口将在隔离开关（S03）开放后提供，请勿在话题内重新执行 /ap room。',
    ].join('\n');
  }

  const selectedAgentIds = await resolveFeishuSelectedAgentIds(command.options['agents']);
  const requestedHandoffLimitValue = command.options['handoff-limit'];
  const requestedHandoffLimit = requestedHandoffLimitValue === undefined
    ? undefined
    : parseLiveRoomHandoffLimit(requestedHandoffLimitValue);
  if (requestedHandoffLimitValue !== undefined && requestedHandoffLimit === null) {
    return `无效 handoff limit。请输入 0-${MAX_LIVE_ROOM_HANDOFF_LIMIT} 的整数。`;
  }
  const effectiveAgentIds = selectedAgentIds.length > 0
    ? selectedAgentIds
    : await resolveDefaultFeishuBindingAgentIds();
  const title = command.args.join(' ').trim() || command.options['title'];
  const requestedProfile =
    parseNewSessionProfile(command.options['profile'])
    || parseNewSessionProfile(command.options['rights'])
    || parseNewSessionProfile(command.options['permission'])
    || parseNewSessionProfile(command.options['access']);
  const permissionConfig = requestedProfile
    ? buildAcpxPermissionConfigForProfile(requestedProfile, [])
    : undefined;
  const requestedModeValue = command.options['mode'];
  const mode = requestedModeValue ? parseLiveRoomMode(requestedModeValue) : null;
  if (requestedModeValue && !mode) {
    return '无效 mode。可选值：discussion、execution、hybrid。';
  }
  // Validate the timeout up front so an invalid value never mutates the binding/room.
  const requestedTimeoutValue = command.options['timeout'] ?? command.options['execution-timeout'];
  if (requestedTimeoutValue !== undefined && parseLiveRoomExecutionTimeoutInput(requestedTimeoutValue).kind === 'invalid') {
    return `无效执行超时。请输入 1-${MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES} 的整数分钟，或 inherit 恢复默认。`;
  }
  const result = await ensureFeishuConversationBinding({
    context,
    selectedAgentIds: effectiveAgentIds,
    title,
    topic: command.options['topic'],
    workingDirectory: command.options['workdir'] || undefined,
    permissionConfig,
    mode: mode || undefined, confirmCreate: true,
  });
  if (requestedTimeoutValue !== undefined) {
    const timeoutUpdate = await applyLiveRoomExecutionTimeoutUpdate({
      roomId: result.liveRoomId,
      requestedValue: requestedTimeoutValue,
      changedBy: context.senderOpenId,
    });
    if (!timeoutUpdate.ok) {
      return timeoutUpdate.error;
    }
  }
  if (typeof requestedHandoffLimit === 'number') {
    const previous = await prisma.liveRoom.findUnique({
      where: { id: result.liveRoomId },
      select: { handoffLimit: true },
    });
    await prisma.liveRoom.update({
      where: { id: result.liveRoomId },
      data: { handoffLimit: requestedHandoffLimit },
    });
    await postLiveRoomMessage({
      roomId: result.liveRoomId,
      content: `系统提示：handoff limit 已从 ${previous?.handoffLimit ?? DEFAULT_LIVE_ROOM_HANDOFF_LIMIT} 调整为 ${requestedHandoffLimit}。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: {
          systemEvent: 'handoff_limit_changed',
          previousHandoffLimit: previous?.handoffLimit ?? null,
          handoffLimit: requestedHandoffLimit,
          changedBy: context.senderOpenId,
        },
      }),
    });
  }
  const [room, access] = await Promise.all([
    prisma.liveRoom.findUnique({
      where: { id: result.liveRoomId },
      select: {
        workingDirectory: true,
        handoffLimit: true,
        executionTimeoutMs: true,
        sourceTask: { select: { workingDirectory: true, acpxPermissionConfig: true } },
      },
    }),
    prisma.feishuUserAccess.findUnique({
      where: { openId: context.senderOpenId },
      select: { workspaceRoot: true },
    }),
  ]);

  return [
    result.created ? '已创建 Feishu 绑定房间。' : '已复用现有 Feishu 绑定房间。',
    `Live Room: ${result.roomTitle} (${result.liveRoomId})`,
    `绑定会话：${context.chatType} ${context.chatId}`,
    `授权根目录：${access?.workspaceRoot || '管理员不受用户根目录限制'}`,
    `实际 workdir：${room?.workingDirectory || room?.sourceTask?.workingDirectory || process.cwd()}`,
    `新增成员数：${result.addedAgentCount}`,
    `权限：${formatLiveRoomPermissionLabel(room?.sourceTask?.acpxPermissionConfig)}`,
    `模式：${result.roomMode}`,
    `Handoff limit：${room?.handoffLimit ?? DEFAULT_LIVE_ROOM_HANDOFF_LIMIT}`,
    `执行超时：${formatLiveRoomExecutionTimeoutMinutes(room?.executionTimeoutMs ?? null)}`,
    '接下来可以直接发送：/ap chat 你的消息',
  ].join('\n');
}

export async function handleHandoffLimitCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  const room = await getBoundLiveRoom(context);
  if (!room) return '当前 Feishu 会话尚未绑定 Live Room。';

  const requestedValue = command.args[0] ?? command.options['limit'];
  if (requestedValue === undefined) {
    return `当前 handoff limit：${room.handoffLimit}。0 表示关闭自动 handoff。`;
  }
  const handoffLimit = parseLiveRoomHandoffLimit(requestedValue);
  if (handoffLimit === null || command.args.length > 1) {
    return `无效 handoff limit。用法：/ap handoff-limit <0-${MAX_LIVE_ROOM_HANDOFF_LIMIT}>`;
  }

  await prisma.liveRoom.update({
    where: { id: room.id },
    data: { handoffLimit },
  });
  await postLiveRoomMessage({
    roomId: room.id,
    content: `系统提示：handoff limit 已从 ${room.handoffLimit} 调整为 ${handoffLimit}。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        systemEvent: 'handoff_limit_changed',
        previousHandoffLimit: room.handoffLimit,
        handoffLimit,
        changedBy: context?.senderOpenId || null,
      },
    }),
  });
  return handoffLimit === 0
    ? '✅ 已关闭当前房间的自动 handoff。'
    : `✅ 当前房间 handoff limit 已设为 ${handoffLimit}。`;
}

export async function handleTimeoutCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  const room = await getBoundLiveRoom(context);
  if (!room) return '当前 Feishu 会话尚未绑定 Live Room。';

  const requestedValue = command.args[0] ?? command.options['timeout'] ?? command.options['minutes'];
  if (requestedValue === undefined) {
    return [
      `当前执行超时：${formatLiveRoomExecutionTimeoutMinutes(room.executionTimeoutMs ?? null)}`,
      `用法：/ap timeout <1-${MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES} 分钟>|inherit`,
    ].join('\n');
  }
  if (command.args.length > 1) {
    return `无效执行超时。用法：/ap timeout <1-${MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES} 分钟>|inherit`;
  }

  const update = await applyLiveRoomExecutionTimeoutUpdate({
    roomId: room.id,
    requestedValue,
    changedBy: context?.senderOpenId || null,
  });
  if (!update.ok) {
    return update.error;
  }
  return update.minutes === null
    ? '✅ 当前房间执行超时已恢复默认（远程 10 分钟 / Platform Local 长任务不限时）。'
    : `✅ 当前房间执行超时已设为 ${update.minutes} 分钟。`;
}

export async function handleModeCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  if (!context) {
    return '当前 mode 命令需要来自 Feishu webhook 的会话上下文。';
  }

  const requested = command.args[0] || command.options['mode'];
  const mode = parseLiveRoomMode(requested);
  if (!mode) {
    return '用法：/ap mode <discussion|execution|hybrid>';
  }

  const room = await setFeishuBoundRoomMode(context, mode);
  const behavior =
    mode === 'execution'
      ? '无显式目标的消息会按成员角色顺序执行。'
      : mode === 'hybrid'
      ? '普通消息按 discussion 路由；发送 /run ... 启动角色队列。'
      : '显式目标优先；无目标时仅 current speaker 回复。';
  return `✅ ${room.title} 已切换为 ${mode}。\n${behavior}`;
}
