import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import { deriveGatewayHarnessOptions } from '@/lib/acpx/catalog';
import { ensureTaskSession } from '@/lib/acpx/session';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '@/lib/acpx/permissions';
import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { getMentionAliases, type LiveRoomMemberWithAgent } from '@/lib/agent-identity';
import type { AcpxExecutionBackend, AcpxParticipantRequest } from '@/lib/acpx/types';
import { relayLiveRoomMessageToFeishu } from '@/lib/feishu-live-room-relay';

export interface LiveRoomCatalogAgent {
  id: string;
  agentRecordId?: string | null;
  gatewayId: string;
  gatewayName: string;
  backend: AcpxExecutionBackend;
  harnessType: string;
  label: string;
  agentName?: string;
  userNickname?: string | null;  // User-defined nickname
  hostname?: string | null;       // Server hostname
  runtimeAgentId?: string;
  status: string;
}

const REMOTE_HOST_ROLE_LABEL_PREFIX = '__remote_host__:';
const LIVE_ROOM_ACPX_PARTICIPANT_PREFIX = 'live-room-member:';

export const encodeLiveRoomRoleLabel = ({
  backend,
  label,
  remoteHostId,
}: {
  backend: string;
  label: string;
  remoteHostId?: string | null;
}) => {
  if (backend === 'remote_ssh' && remoteHostId) {
    return `${label} ${REMOTE_HOST_ROLE_LABEL_PREFIX}${remoteHostId}`;
  }

  return label;
};

export const extractRemoteHostIdFromRoleLabel = (value?: string | null) => {
  const match = value?.match(/__remote_host__:([^\s]+)/);
  return match?.[1] || null;
};

export const getLiveRoomParticipantContinuationKey = (memberId: string) =>
  `${LIVE_ROOM_ACPX_PARTICIPANT_PREFIX}${memberId}`;

export interface LiveRoomMemberPayload {
  id: string;
  roomId: string;
  memberType: string;
  displayName: string;
  agentNameSnapshot: string | null;
  harnessType: string | null;
  backend: string | null;
  runtimeAgentId: string | null;
  roleLabel: string | null;
  joinStatus: string;
  presenceStatus: string;
  canReply: boolean;
  sortOrder: number;
  gatewayId: string | null;
  gatewayName: string | null;
  agentRecordId: string | null;
}

export interface LiveRoomMessagePayload {
  id: string;
  roomId: string;
  senderMemberId: string | null;
  senderName: string;
  senderLabel: string;
  senderType: string;
  content: string;
  messageType: string;
  visibility: string;
  topicSnapshot: string | null;
  createdAt: string;
  replyToMessageId: string | null;
  metadata: Record<string, unknown> | null;
}

export type LiveRoomDeliveryIntent =
  | 'broadcast'
  | 'directed_visible'
  | 'user_target'
  | 'mention'
  | 'ask'
  | 'handoff'
  | 'mention_all';

export interface LiveRoomMessageMetadata {
  senderKind?: 'user' | 'assistant' | 'system';
  mentionedMemberIds?: string[];
  primaryTargetMemberId?: string | null;
  deliveryIntent?: LiveRoomDeliveryIntent;
  visibilityMode?: 'room' | 'directed_visible';
  inReplyToMessageId?: string | null;
  handoffToMemberId?: string | null;
  mentionedAll?: boolean;
  expectedResponderMemberIds?: string[];
  requiredResponseMode?: 'none' | 'any_one' | 'all';
  [key: string]: unknown;
}

export interface LiveRoomSummaryPayload {
  id: string;
  title: string;
  description: string | null;
  currentTopic: string | null;
  mode: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  currentSpeakerMemberId: string | null;
  currentSpeakerName: string | null;
  memberCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

export interface LiveRoomPendingReplyPayload {
  memberId: string;
  displayName: string;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  oldestPendingAt: string;
  newestPendingAt: string;
  newestPendingAgeSeconds: number;
  lastProgressAt?: string | null;
  lastProgressAgeSeconds?: number | null;
  progressLabel?: string | null;
  activeDeliveryId?: string | null;
  backend?: string | null;
  harnessType?: string | null;
  interruptSupported?: boolean;
  status: 'queued' | 'running' | 'stalled';
}

export interface LiveRoomMentionableMember {
  id: string;
  displayName: string;
  runtimeAgentId?: string | null;
  gateway?: {
    name: string;
  } | null;
  harnessType?: string | null;
  canReply?: boolean;
}

export const detectLiveRoomMentionAll = (content: string) => /(^|[\s(])[@$]all\b/i.test(content);

export const getLiveRoomMemberRosterLabel = (member: {
  displayName: string;
  memberType?: string;
  backend?: string | null;
  gateway?: { name: string } | null;
  gatewayName?: string | null;
  harnessType?: string | null;
  canReply?: boolean;
}) => {
  if (member.memberType === 'user') {
    return `${member.displayName} / user`;
  }

  const sourceLabel =
    member.backend === 'platform_local'
      ? 'Platform Local'
      : member.backend === 'remote_ssh'
      ? `Remote SSH · ${member.gateway?.name || member.gatewayName || 'Remote Host'}`
      : (member.gateway?.name || member.gatewayName || 'Gateway');

  return `${member.displayName} / ${sourceLabel} / ${member.harnessType || 'agent'}${member.canReply ? ' / can-reply' : ''}`;
};

export const buildLiveRoomRosterText = (members: Array<{
  displayName: string;
  memberType?: string;
  backend?: string | null;
  gateway?: { name: string } | null;
  gatewayName?: string | null;
  harnessType?: string | null;
  canReply?: boolean;
}>) => members.map((member) => `- ${getLiveRoomMemberRosterLabel(member)}`).join('\n');

export const parseLiveRoomMessageMetadata = (value?: string | null): LiveRoomMessageMetadata | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? parsed as LiveRoomMessageMetadata
      : null;
  } catch {
    return null;
  }
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXPLICIT_MENTION_PREFIX_PATTERN = '[@$]';
const MENTION_BOUNDARY_CHAR_CLASS = `[\\s,.;:!?\\/()\\[\\]{}"'，。；：！？、】【（）《》、]`;
const EXPLICIT_MENTION_SUFFIX_PATTERN = `${MENTION_BOUNDARY_CHAR_CLASS}*`;

interface MentionMatchResult {
  index: number;
  matchedAlias: string;
  matchedLength: number;
}

const findBestExplicitMentionMatch = (content: string, aliases: string[]): MentionMatchResult | null => {
  // 按长度降序排序，优先匹配更长的别名（更精确）
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);
  let bestMatch: MentionMatchResult | null = null;

  for (const alias of sortedAliases) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      continue;
    }

    // 使用更精确的匹配：@别名 / $别名，后面必须是空格、标点符号或字符串结束
    // 这样 "Platform Local Claude" 不会只匹配 "Platform"
    const explicitMentionRegex = new RegExp(
      `${EXPLICIT_MENTION_PREFIX_PATTERN}${escapeRegExp(trimmedAlias)}(?:${MENTION_BOUNDARY_CHAR_CLASS}|$)`,
      'i'
    );
    const explicitMatch = explicitMentionRegex.exec(content);

    if (explicitMatch) {
      const matchLength = trimmedAlias.length;

      // 没有之前的匹配，直接使用
      if (!bestMatch) {
        bestMatch = {
          index: explicitMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }

      // 优先选择位置更靠前的匹配
      if (explicitMatch.index < bestMatch.index) {
        bestMatch = {
          index: explicitMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }

      // 位置相同时，优先选择更长的匹配（更精确）
      if (explicitMatch.index === bestMatch.index && matchLength > bestMatch.matchedLength) {
        bestMatch = {
          index: explicitMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }
    }
  }

  return bestMatch;
};

const findBestPlainMentionMatch = (content: string, aliases: string[]): MentionMatchResult | null => {
  // 按长度降序排序，优先匹配更长的别名
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);
  let bestMatch: MentionMatchResult | null = null;

  for (const alias of sortedAliases) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      continue;
    }

    // 使用更精确的边界匹配
    const plainMentionRegex = new RegExp(
      `(?:^|${MENTION_BOUNDARY_CHAR_CLASS})${escapeRegExp(trimmedAlias)}(?:${MENTION_BOUNDARY_CHAR_CLASS}|$)`,
      'i'
    );
    const plainMatch = plainMentionRegex.exec(content);

    if (plainMatch) {
      const matchLength = trimmedAlias.length;

      if (!bestMatch) {
        bestMatch = {
          index: plainMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }

      if (plainMatch.index < bestMatch.index) {
        bestMatch = {
          index: plainMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }

      if (plainMatch.index === bestMatch.index && matchLength > bestMatch.matchedLength) {
        bestMatch = {
          index: plainMatch.index,
          matchedAlias: trimmedAlias,
          matchedLength: matchLength,
        };
        continue;
      }
    }
  }

  return bestMatch;
};

const toCatalogAgentId = (agent: Awaited<ReturnType<typeof deriveGatewayHarnessOptions>>[number]) =>
  `${agent.executionBackend}:${agent.gatewayId}:${agent.runtimeAgentId || agent.agentId || agent.harnessType}`;

export const listLiveRoomCatalogAgents = async (): Promise<LiveRoomCatalogAgent[]> => {
  const options = await deriveGatewayHarnessOptions();

  return options.map((option) => ({
    id: toCatalogAgentId(option),
    agentRecordId: option.executionBackend === 'gateway_openclaw' ? option.agentId || null : null,
    gatewayId: option.gatewayId,
    gatewayName: option.gatewayName,
    backend: option.executionBackend,
    harnessType: option.harnessType,
    label: option.harnessLabel,
    agentName: option.agentName || null || undefined,
    userNickname: option.userNickname || null,
    hostname: option.hostname || null,
    runtimeAgentId: option.runtimeAgentId || option.agentId || undefined,
    status: option.status,
  }));
};

export const serializeLiveRoomMember = (member: {
  id: string;
  roomId: string;
  memberType: string;
  displayName: string;
  agentNameSnapshot: string | null;
  harnessType: string | null;
  backend: string | null;
  runtimeAgentId: string | null;
  roleLabel: string | null;
  joinStatus: string;
  presenceStatus: string;
  canReply: boolean;
  sortOrder: number;
  gatewayId: string | null;
  agentRecordId: string | null;
  gateway?: { name: string } | null;
  agentRecord?: {
    userNickname: string | null;
    name: string;
  } | null;
}): LiveRoomMemberPayload => {
  // Prefer the current nickname from Agent record over the stored snapshot
  const currentNickname = member.agentRecord?.userNickname || null;
  const displayName = currentNickname || member.displayName;
  const agentNameSnapshot = currentNickname || member.agentNameSnapshot;

  return {
    id: member.id,
    roomId: member.roomId,
    memberType: member.memberType,
    displayName,
    agentNameSnapshot,
    harnessType: member.harnessType,
    backend: member.backend,
    runtimeAgentId: member.runtimeAgentId,
    roleLabel: member.roleLabel,
    joinStatus: member.joinStatus,
    presenceStatus: member.presenceStatus,
    canReply: member.canReply,
    sortOrder: member.sortOrder,
    gatewayId: member.gatewayId,
    gatewayName:
      member.gateway?.name
      || (member.backend === 'remote_ssh' ? extractRemoteHostIdFromRoleLabel(member.roleLabel) : null),
    agentRecordId: member.agentRecordId,
  };
};

export const buildLiveRoomAcpxParticipant = (member: {
  id: string;
  displayName: string;
  backend?: string | null;
  harnessType?: string | null;
  gatewayId?: string | null;
  gatewayName?: string | null;
  runtimeAgentId?: string | null;
}): AcpxParticipantRequest => ({
  gatewayId:
    member.backend === 'platform_local'
      ? 'platform-local'
      : member.gatewayId || 'platform-local',
  gatewayName:
    member.backend === 'platform_local'
      ? 'Platform Local'
      : member.gatewayName || member.gatewayId || 'Gateway',
  executionBackend: (member.backend || 'platform_local') as AcpxExecutionBackend,
  harnessType: member.harnessType || 'codex',
  harnessLabel: member.harnessType || 'agent',
  role: member.displayName,
  agentId: member.runtimeAgentId || undefined,
  agentName: member.displayName,
  continuationKey: getLiveRoomParticipantContinuationKey(member.id),
});

export const serializeLiveRoomMessage = (message: {
  id: string;
  roomId: string;
  senderMemberId: string | null;
  content: string;
  messageType: string;
  visibility: string;
  topicSnapshot: string | null;
  createdAt: Date;
  replyToMessageId: string | null;
  metadata: string | null;
  senderMember?: {
    displayName: string;
    memberType: string;
    backend?: string | null;
    gateway?: {
      name: string;
    } | null;
    gatewayName?: string | null;
    harnessType?: string | null;
  } | null;
}): LiveRoomMessagePayload => ({
  id: message.id,
  roomId: message.roomId,
  senderMemberId: message.senderMemberId,
  senderName: message.senderMember?.displayName || '系统',
  senderLabel:
    message.senderMember?.memberType === 'user'
      ? message.senderMember.displayName
      : message.senderMember
      ? `${message.senderMember.displayName} · ${
          message.senderMember.backend === 'platform_local'
            ? 'Platform Local'
            : message.senderMember.backend === 'remote_ssh'
            ? `Remote SSH · ${message.senderMember.gateway?.name || message.senderMember.gatewayName || 'Remote Host'}`
            : (message.senderMember.gateway?.name || message.senderMember.gatewayName || 'Gateway')
        } / ${message.senderMember.harnessType || 'agent'}`
      : '系统',
  senderType: message.senderMember?.memberType || 'system',
  content: message.content,
  messageType: message.messageType,
  visibility: message.visibility,
  topicSnapshot: message.topicSnapshot,
  createdAt: message.createdAt.toISOString(),
  replyToMessageId: message.replyToMessageId,
  metadata: parseLiveRoomMessageMetadata(message.metadata),
});

export const serializeLiveRoomSummary = (room: {
  id: string;
  title: string;
  description: string | null;
  currentTopic: string | null;
  mode: string;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  currentSpeakerMemberId: string | null;
  currentSpeaker?: {
    displayName: string;
    agentRecord?: {
      userNickname: string | null;
    } | null;
  } | null;
  members?: Array<unknown>;
  messages?: Array<{ content: string; createdAt: Date }>;
}): LiveRoomSummaryPayload => {
  const latestMessage = room.messages?.[0] || null;
  // Prefer current nickname from agent record
  const currentSpeakerName =
    room.currentSpeaker?.agentRecord?.userNickname ||
    room.currentSpeaker?.displayName ||
    null;

  return {
    id: room.id,
    title: room.title,
    description: room.description,
    currentTopic: room.currentTopic,
    mode: room.mode,
    status: room.status,
    createdBy: room.createdBy,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    currentSpeakerMemberId: room.currentSpeakerMemberId,
    currentSpeakerName,
    memberCount: room.members?.length || 0,
    lastMessagePreview: latestMessage?.content || null,
    lastMessageAt: latestMessage?.createdAt.toISOString() || null,
  };
};

export const listLiveRoomPendingReplies = async (roomId: string): Promise<LiveRoomPendingReplyPayload[]> => {
  const pendingDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      deliveryStatus: {
        in: ['pending', 'running'],
      },
      roomMessage: {
        roomId,
      },
    },
    include: {
      targetMember: {
        select: {
          id: true,
          displayName: true,
          backend: true,
          harnessType: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });
  const latestSessions = await prisma.liveRoomMemberSession.findMany({
    where: {
      roomId,
      memberId: {
        in: pendingDeliveries.map((delivery) => delivery.targetMember.id),
      },
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  const now = Date.now();
  const grouped = new Map<string, LiveRoomPendingReplyPayload>();
  const latestSessionByMemberId = new Map<string, typeof latestSessions[number]>();

  for (const session of latestSessions) {
    if (!latestSessionByMemberId.has(session.memberId)) {
      latestSessionByMemberId.set(session.memberId, session);
    }
  }

  for (const delivery of pendingDeliveries) {
    const existing = grouped.get(delivery.targetMember.id);
    const createdAtIso = delivery.createdAt.toISOString();
    const createdAtMs = delivery.createdAt.getTime();

    if (!existing) {
      grouped.set(delivery.targetMember.id, {
        memberId: delivery.targetMember.id,
        displayName: delivery.targetMember.displayName,
        pendingCount: 1,
        queuedCount: delivery.deliveryStatus === 'pending' ? 1 : 0,
        runningCount: delivery.deliveryStatus === 'running' ? 1 : 0,
        oldestPendingAt: createdAtIso,
        newestPendingAt: createdAtIso,
        newestPendingAgeSeconds: Math.max(0, Math.floor((now - createdAtMs) / 1000)),
        lastProgressAt: null,
        lastProgressAgeSeconds: null,
        progressLabel: null,
        activeDeliveryId: delivery.deliveryStatus === 'running' ? delivery.id : null,
        backend: delivery.targetMember.backend,
        harnessType: delivery.targetMember.harnessType,
        interruptSupported: delivery.targetMember.backend === 'remote_ssh',
        status: 'running',
      });
      continue;
    }

    existing.pendingCount += 1;
    if (delivery.deliveryStatus === 'pending') {
      existing.queuedCount += 1;
    } else {
      existing.runningCount += 1;
      existing.activeDeliveryId = delivery.id;
    }
    if (createdAtIso < existing.oldestPendingAt) {
      existing.oldestPendingAt = createdAtIso;
    }
    if (createdAtIso > existing.newestPendingAt) {
      existing.newestPendingAt = createdAtIso;
      existing.newestPendingAgeSeconds = Math.max(0, Math.floor((now - createdAtMs) / 1000));
    }
  }

  return Array.from(grouped.values())
    .map((item) => {
      const session = latestSessionByMemberId.get(item.memberId);
      const lastProgressAt = session?.lastHeartbeatAt?.toISOString() || null;
      const lastProgressAgeSeconds = session?.lastHeartbeatAt
        ? Math.max(0, Math.floor((now - session.lastHeartbeatAt.getTime()) / 1000))
        : null;
      const progressLabel = session?.lastError?.startsWith('progress:')
        ? session.lastError.replace(/^progress:/, '')
        : null;

      return {
        ...item,
        lastProgressAt,
        lastProgressAgeSeconds,
        progressLabel,
        interruptSupported: item.interruptSupported && item.runningCount > 0,
        status: (
          item.runningCount === 0
            ? 'queued'
            : item.newestPendingAgeSeconds >= 180 || ((lastProgressAgeSeconds ?? 0) >= 180)
            ? 'stalled'
            : 'running'
        ) as LiveRoomPendingReplyPayload['status'],
      };
    })
    .sort((left, right) => right.newestPendingAt.localeCompare(left.newestPendingAt));
};

export const ensureLiveRoomUserMember = async (roomId: string) => {
  const existing = await prisma.liveRoomMember.findFirst({
    where: {
      roomId,
      memberType: 'user',
      displayName: '你',
    },
  });

  if (existing) {
    return existing;
  }

  const maxSort = await prisma.liveRoomMember.aggregate({
    where: { roomId },
    _max: { sortOrder: true },
  });

  return prisma.liveRoomMember.create({
    data: {
      roomId,
      memberType: 'user',
      displayName: '你',
      canReply: false,
      sortOrder: (maxSort._max.sortOrder || 0) + 1,
      presenceStatus: 'online',
    },
  });
};

export const syncLiveRoomSourceTask = async (roomId: string) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });

  if (!room) {
    return null;
  }

  const workingDirectoryRows = await prisma.$queryRaw<Array<{ workingDirectory: string | null }>>`
    SELECT "workingDirectory"
    FROM "LiveRoom"
    WHERE "id" = ${roomId}
    LIMIT 1
  `;
  const workingDirectory = workingDirectoryRows[0]?.workingDirectory || null;

  const participants = room.members
    .filter((member) => member.canReply)
    .map((member) => buildLiveRoomAcpxParticipant({
      id: member.id,
      displayName: member.displayName,
      backend: member.backend,
      harnessType: member.harnessType,
      gatewayId: member.backend === 'remote_ssh'
        ? extractRemoteHostIdFromRoleLabel(member.roleLabel) || member.gatewayId
        : member.gatewayId,
      gatewayName: member.gateway?.name || null,
      runtimeAgentId: member.runtimeAgentId,
    }));

  if (participants.length === 0) {
    return room.sourceTask || null;
  }

  const taskName = `Live Room · ${room.title}`;
  const taskDescription = room.currentTopic
    ? `Backs live room "${room.title}". Current topic: ${room.currentTopic}`
    : `Backs live room "${room.title}".`;
  const taskDataBase = {
    name: taskName,
    description: taskDescription,
    executionMode: 'acpx',
    acpxParticipants: JSON.stringify(participants),
    workingDirectory: workingDirectory || process.cwd(),
    result: JSON.stringify({
      executionMode: 'acpx',
      source: 'live_room',
      liveRoomId: room.id,
      participantCount: participants.length,
    }),
  };

  const sourceTask = room.sourceTask
    ? await prisma.task.update({
        where: { id: room.sourceTask.id },
        // acpxPermissionConfig is intentionally excluded: it may have been
        // updated by /ap grant or /ap new-session and must not be reset here.
        data: taskDataBase,
        include: {
          currentTaskSession: true,
        },
      })
    : await prisma.task.create({
        data: {
          ...taskDataBase,
          acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG),
        },
        include: {
          currentTaskSession: true,
        },
      });

  if (room.sourceTaskId !== sourceTask.id) {
    await prisma.liveRoom.update({
      where: { id: room.id },
      data: {
        sourceTaskId: sourceTask.id,
      },
    });
  }

  await ensureTaskSession(sourceTask.id, {
    taskName: sourceTask.name,
    metadata: {
      source: 'live_room',
      liveRoomId: room.id,
      participantCount: participants.length,
    },
  });
  await ensureTaskChatRoom(sourceTask.id, sourceTask.name);

  return prisma.task.findUnique({
    where: { id: sourceTask.id },
    include: {
      currentTaskSession: true,
    },
  });
};

export const emitLiveRoomMessage = (message: LiveRoomMessagePayload) => {
  const io = getSocketServer();
  if (!io) {
    return;
  }

  io.to(`live-room:${message.roomId}`).emit('live-room:message', message);
};

export const emitLiveRoomUpdated = async (roomId: string) => {
  const io = getSocketServer();
  if (!io) {
    return;
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      members: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!room) {
    return;
  }

  io.emit('live-room:updated', serializeLiveRoomSummary(room));
};

export const emitLiveRoomDeleted = (roomId: string) => {
  const io = getSocketServer();
  if (!io) {
    return;
  }

  io.emit('live-room:deleted', { roomId });
};

export const postLiveRoomMessage = async ({
  roomId,
  senderMemberId,
  content,
  messageType,
  visibility = 'room',
  replyToMessageId,
  metadata,
  matchedAlias,
}: {
  roomId: string;
  senderMemberId?: string | null;
  content: string;
  messageType: string;
  visibility?: string;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** 匹配到的 @提及 别名，用于正确剥离 @提及 部分 */
  matchedAlias?: string | null;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
        },
      },
      sourceTask: true,
    },
  });

  const created = await prisma.liveRoomMessage.create({
    data: {
      roomId,
      senderMemberId: senderMemberId || null,
      content,
      messageType,
      visibility,
      replyToMessageId: replyToMessageId || null,
      topicSnapshot: room?.currentTopic || null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
    include: {
      senderMember: {
        include: {
          gateway: true,
        },
      },
    },
  });

  const parsedMetadata = parseLiveRoomMessageMetadata(created.metadata);
  if (room?.sourceTask) {
    const taskRoom = await ensureTaskChatRoom(room.sourceTask.id, room.sourceTask.name);
    const targetMember = parsedMetadata?.primaryTargetMemberId
      ? room.members.find((member) => member.id === parsedMetadata.primaryTargetMemberId) || null
      : null;
    const targetParticipant = targetMember
      ? buildLiveRoomAcpxParticipant({
          id: targetMember.id,
          displayName: targetMember.displayName,
          backend: targetMember.backend,
          harnessType: targetMember.harnessType,
          gatewayId: targetMember.backend === 'remote_ssh'
            ? extractRemoteHostIdFromRoleLabel(targetMember.roleLabel) || targetMember.gatewayId
            : targetMember.gatewayId,
          gatewayName: targetMember.gateway?.name || null,
          runtimeAgentId: targetMember.runtimeAgentId,
        })
      : null;

    // 去掉消息开头的显式提及部分，避免 Claude CLI 误解析为命令
    // 但在 Live Room 中仍显示完整内容
    let contentForTaskRoom = created.content;

    // 对于用户消息，总是尝试去掉开头的显式提及
    // 格式: "@xxx yyy" / "$xxx yyy" -> "yyy"
    if (created.senderMember?.memberType === 'user') {
      // 优先使用检测到的匹配别名进行精确剥离
      const matchedPrefix = matchedAlias
        ? ['@', '$'].find((prefix) => created.content.startsWith(`${prefix}${matchedAlias}`)) || null
        : null;
      if (matchedAlias && matchedPrefix) {
        const matchedMentionRegex = new RegExp(
          `^${escapeRegExp(matchedPrefix)}${escapeRegExp(matchedAlias)}${EXPLICIT_MENTION_SUFFIX_PATTERN}`,
          'i'
        );
        contentForTaskRoom = created.content.replace(matchedMentionRegex, '').trim();
        if (process.env.DEBUG_MENTION_DETECTION === 'true') {
          console.log('[Task Room] Stripped explicit mention using matched alias:', {
            original: created.content,
            matchedAlias,
            stripped: contentForTaskRoom,
          });
        }
      } else {
        // 降级方案：使用正则表达式剥离首个 @/$ 提及 token
        const greedyMatch = created.content.match(/^[@$]\S+\s+([\s\S]+)$/);
        if (greedyMatch && greedyMatch[1].trim()) {
          contentForTaskRoom = greedyMatch[1].trim();
          if (process.env.DEBUG_MENTION_DETECTION === 'true') {
            console.log('[Task Room] Stripped explicit mention using greedy regex:', {
              original: created.content,
              stripped: contentForTaskRoom,
            });
          }
        } else {
          // 最后尝试非贪婪匹配
          const nonGreedyMatch = created.content.match(/^[@$]\S+\s+([\s\S]*)$/);
          if (nonGreedyMatch && nonGreedyMatch[1].trim()) {
            contentForTaskRoom = nonGreedyMatch[1].trim();
            if (process.env.DEBUG_MENTION_DETECTION === 'true') {
              console.log('[Task Room] Stripped explicit mention using non-greedy regex:', {
                original: created.content,
                stripped: contentForTaskRoom,
              });
            }
          }
        }
      }
    }

    await postTaskRoomMessage({
      roomId: taskRoom.id,
      content: contentForTaskRoom || created.content,
      userId: created.senderMember
        ? created.senderMember.memberType === 'user'
          ? 'task-room-user'
          : `${getLiveRoomParticipantContinuationKey(created.senderMember.id)}:speaker`
        : 'system',
      userName: created.senderMember?.displayName || '系统',
      targetType: parsedMetadata?.mentionedAll
        ? 'all'
        : targetParticipant
        ? 'participant'
        : 'task',
      targetParticipantKey: targetParticipant ? getTaskRoomParticipantTargetKey(targetParticipant) : null,
      targetParticipantLabel: targetParticipant ? getTaskRoomParticipantTargetLabel(targetParticipant) : null,
    });
  }

  const payload = serializeLiveRoomMessage(created);
  emitLiveRoomMessage(payload);
  void relayLiveRoomMessageToFeishu(payload).catch((error) => {
    console.error('Failed to relay live room message to Feishu:', error);
  });
  await emitLiveRoomUpdated(roomId);
  return payload;
};

export const getLiveRoomTranscript = async (roomId: string, limit = 24) => {
  const messages = await prisma.liveRoomMessage.findMany({
    where: { roomId },
    include: {
      senderMember: {
        include: {
          gateway: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  return messages.map((message) => {
    const sender = message.senderMember?.displayName || '系统';
    return `[${message.createdAt.toLocaleString('zh-CN', { hour12: false })}] ${sender}: ${message.content}`;
  }).join('\n');
};

export const detectMentionedLiveRoomMembers = ({
  content,
  members,
  senderMemberId,
}: {
  content: string;
  members: LiveRoomMentionableMember[];
  senderMemberId?: string | null;
}) => {
  const explicitMatches: Array<{ memberId: string; index: number; matchedAlias: string }> = [];
  const plainMatches: Array<{ memberId: string; index: number; matchedAlias: string }> = [];

  // 调试日志：记录提及检测详情
  const debugLog = process.env.DEBUG_MENTION_DETECTION === 'true';

  if (debugLog) {
    console.log('[Mention Detection] Content:', content);
    console.log('[Mention Detection] Members:', members.map(m => ({ id: m.id, displayName: m.displayName })));
  }

  for (const member of members) {
    if (member.id === senderMemberId) {
      continue;
    }

    // 使用 Agent Identity 系统获取提及别名（优先级: 昵称 > 短别名 > 显示名称）
    const aliases = getMentionAliases(member as LiveRoomMemberWithAgent);

    if (debugLog) {
      console.log(`[Mention Detection] Checking ${member.displayName}, aliases:`, aliases);
    }

    const explicitMatch = findBestExplicitMentionMatch(content, aliases);
    if (explicitMatch) {
      if (debugLog) {
        console.log(`[Mention Detection] ✓ Explicit match for ${member.displayName}:`, explicitMatch);
      }
      explicitMatches.push({
        memberId: member.id,
        index: explicitMatch.index,
        matchedAlias: explicitMatch.matchedAlias,
      });
      continue;
    }

    const plainMatch = findBestPlainMentionMatch(content, aliases);
    if (plainMatch) {
      if (debugLog) {
        console.log(`[Mention Detection] ○ Plain match for ${member.displayName}:`, plainMatch);
      }
      plainMatches.push({
        memberId: member.id,
        index: plainMatch.index,
        matchedAlias: plainMatch.matchedAlias,
      });
    }
  }

  const resolvedMatches = explicitMatches.length > 0 ? explicitMatches : plainMatches;
  const matchType = explicitMatches.length > 0 ? 'explicit' : plainMatches.length > 0 ? 'plain' : null;

  // 排序：位置优先，相同位置时优先选择更长匹配（更精确）
  const sorted = resolvedMatches.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    // 位置相同时，优先选择别名更长的匹配（通常意味着更精确）
    return right.matchedAlias.length - left.matchedAlias.length;
  });

  if (debugLog) {
    console.log('[Mention Detection] Resolved matches:', sorted);
  }

  return {
    memberIds: sorted.map((item) => item.memberId),
    // 返回第一个（主要）匹配的别名，用于剥离 @提及
    primaryMatchedAlias: sorted.length > 0 ? sorted[0].matchedAlias : null,
    matchType,
  };
};

export const mergeLiveRoomMentionedMemberIds = ({
  explicitMentionMemberIds = [],
  detectedMentionedMemberIds = [],
  members,
  senderMemberId,
}: {
  explicitMentionMemberIds?: string[];
  detectedMentionedMemberIds?: string[];
  members: LiveRoomMentionableMember[];
  senderMemberId?: string | null;
}) => {
  const allowedMemberIds = new Set(
    members
      .map((member) => member.id)
      .filter((memberId) => memberId !== senderMemberId)
  );
  const merged = [...explicitMentionMemberIds, ...detectedMentionedMemberIds]
    .filter((memberId) => allowedMemberIds.has(memberId));

  return Array.from(new Set(merged));
};

export const resolveLiveRoomMessageMetadata = ({
  senderKind,
  targetMemberId,
  mentionedMemberIds,
  mentionedAll,
  visibilityMode,
  expectedResponderMemberIds,
  requiredResponseMode,
  replyToMessageId,
  handoffToMemberId,
  extras,
}: {
  senderKind: 'user' | 'assistant' | 'system';
  targetMemberId?: string | null;
  mentionedMemberIds?: string[];
  mentionedAll?: boolean;
  visibilityMode?: 'room' | 'directed_visible';
  expectedResponderMemberIds?: string[];
  requiredResponseMode?: 'none' | 'any_one' | 'all';
  replyToMessageId?: string | null;
  handoffToMemberId?: string | null;
  extras?: Record<string, unknown>;
}): LiveRoomMessageMetadata => {
  const uniqueMentionedMemberIds = Array.from(new Set((mentionedMemberIds || []).filter(Boolean)));
  const primaryTargetMemberId = handoffToMemberId || targetMemberId || uniqueMentionedMemberIds[0] || null;

  let deliveryIntent: LiveRoomDeliveryIntent = 'broadcast';
  if (handoffToMemberId) {
    // 明确的 handoff，无论谁发送都应该触发
    deliveryIntent = 'handoff';
  } else if (mentionedAll) {
    deliveryIntent = 'mention_all';
  } else if (visibilityMode === 'directed_visible' && primaryTargetMemberId) {
    deliveryIntent = 'directed_visible';
  } else if (targetMemberId) {
    // 有明确目标时，用户消息触发 user_target，agent 消息触发 ask
    deliveryIntent = senderKind === 'user' ? 'user_target' : 'ask';
  } else if (uniqueMentionedMemberIds.length > 0 && senderKind === 'user') {
    // 只有用户消息的 @提及才自动触发回复
    // Agent 消息中的 @提及只是引用，不触发新回复
    deliveryIntent = 'mention';
  } else if (uniqueMentionedMemberIds.length > 0 && senderKind === 'assistant') {
    // Agent 消息中的 @提及设置为 broadcast（不触发自动回复）
    // 除非是明确的 handoff 或 ask 模式
    deliveryIntent = 'broadcast';
  }

  return {
    senderKind,
    mentionedMemberIds: uniqueMentionedMemberIds,
    primaryTargetMemberId,
    deliveryIntent,
    visibilityMode: visibilityMode || 'room',
    inReplyToMessageId: replyToMessageId || null,
    handoffToMemberId: handoffToMemberId || null,
    mentionedAll: Boolean(mentionedAll),
    expectedResponderMemberIds: expectedResponderMemberIds || [],
    requiredResponseMode: requiredResponseMode || (mentionedAll ? 'all' : primaryTargetMemberId ? 'any_one' : 'any_one'),
    ...(extras || {}),
  };
};
