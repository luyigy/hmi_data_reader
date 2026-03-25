import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import { deriveGatewayHarnessOptions } from '@/lib/acpx/catalog';

export interface LiveRoomCatalogAgent {
  id: string;
  agentRecordId?: string | null;
  gatewayId: string;
  gatewayName: string;
  backend: 'platform_local' | 'gateway_openclaw';
  harnessType: string;
  label: string;
  agentName?: string;
  runtimeAgentId?: string;
  status: string;
}

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

export interface LiveRoomMentionableMember {
  id: string;
  displayName: string;
  runtimeAgentId?: string | null;
  gateway?: {
    name: string;
  } | null;
  harnessType?: string | null;
}

const parseMetadata = (value?: string | null) => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
}): LiveRoomMemberPayload => ({
  id: member.id,
  roomId: member.roomId,
  memberType: member.memberType,
  displayName: member.displayName,
  agentNameSnapshot: member.agentNameSnapshot,
  harnessType: member.harnessType,
  backend: member.backend,
  runtimeAgentId: member.runtimeAgentId,
  roleLabel: member.roleLabel,
  joinStatus: member.joinStatus,
  presenceStatus: member.presenceStatus,
  canReply: member.canReply,
  sortOrder: member.sortOrder,
  gatewayId: member.gatewayId,
  gatewayName: member.gateway?.name || null,
  agentRecordId: member.agentRecordId,
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
    gateway?: {
      name: string;
    } | null;
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
      ? `${message.senderMember.displayName} · ${message.senderMember.gateway?.name || 'Platform Local'} / ${message.senderMember.harnessType || 'agent'}`
      : '系统',
  senderType: message.senderMember?.memberType || 'system',
  content: message.content,
  messageType: message.messageType,
  visibility: message.visibility,
  topicSnapshot: message.topicSnapshot,
  createdAt: message.createdAt.toISOString(),
  replyToMessageId: message.replyToMessageId,
  metadata: parseMetadata(message.metadata),
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
  currentSpeaker?: { displayName: string } | null;
  members?: Array<unknown>;
  messages?: Array<{ content: string; createdAt: Date }>;
}): LiveRoomSummaryPayload => {
  const latestMessage = room.messages?.[0] || null;

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
    currentSpeakerName: room.currentSpeaker?.displayName || null,
    memberCount: room.members?.length || 0,
    lastMessagePreview: latestMessage?.content || null,
    lastMessageAt: latestMessage?.createdAt.toISOString() || null,
  };
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

export const postLiveRoomMessage = async ({
  roomId,
  senderMemberId,
  content,
  messageType,
  visibility = 'room',
  replyToMessageId,
  metadata,
}: {
  roomId: string;
  senderMemberId?: string | null;
  content: string;
  messageType: string;
  visibility?: string;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { currentTopic: true },
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

  const payload = serializeLiveRoomMessage(created);
  emitLiveRoomMessage(payload);
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
  const normalized = content.toLowerCase();
  const matches: string[] = [];

  for (const member of members) {
    if (member.id === senderMemberId) {
      continue;
    }

    const aliases = [
      member.displayName,
      member.runtimeAgentId || '',
      member.gateway?.name && member.harnessType
        ? `${member.displayName} · ${member.gateway.name} / ${member.harnessType}`
        : '',
      member.gateway?.name
        ? `${member.displayName} @ ${member.gateway.name}`
        : '',
    ]
      .map((item) => item.trim())
      .filter(Boolean);

    const matched = aliases.some((alias) => {
      const loweredAlias = alias.toLowerCase();
      if (normalized.includes(`@${loweredAlias}`)) {
        return true;
      }

      if (normalized.includes(loweredAlias)) {
        return true;
      }

      const regex = new RegExp(`\\b${escapeRegExp(loweredAlias)}\\b`, 'i');
      return regex.test(content);
    });

    if (matched) {
      matches.push(member.id);
    }
  }

  return matches;
};
