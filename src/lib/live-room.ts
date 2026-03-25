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

export type LiveRoomDeliveryIntent =
  | 'broadcast'
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

export const detectLiveRoomMentionAll = (content: string) => /(^|[\s(])@all\b/i.test(content);

export const getLiveRoomMemberRosterLabel = (member: {
  displayName: string;
  memberType?: string;
  gateway?: { name: string } | null;
  gatewayName?: string | null;
  harnessType?: string | null;
  canReply?: boolean;
}) => {
  if (member.memberType === 'user') {
    return `${member.displayName} / user`;
  }

  return `${member.displayName} / ${member.gateway?.name || member.gatewayName || 'Platform Local'} / ${member.harnessType || 'agent'}${member.canReply ? ' / can-reply' : ''}`;
};

export const buildLiveRoomRosterText = (members: Array<{
  displayName: string;
  memberType?: string;
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

const findEarliestMentionIndex = (content: string, aliases: string[]) => {
  let bestIndex = Number.POSITIVE_INFINITY;

  for (const alias of aliases) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      continue;
    }

    const explicitMentionRegex = new RegExp(`@${escapeRegExp(trimmedAlias)}\\b`, 'i');
    const explicitMatch = explicitMentionRegex.exec(content);
    if (explicitMatch && explicitMatch.index < bestIndex) {
      bestIndex = explicitMatch.index;
    }
  }

  if (bestIndex !== Number.POSITIVE_INFINITY) {
    return bestIndex;
  }

  for (const alias of aliases) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      continue;
    }

    const plainMentionRegex = new RegExp(`\\b${escapeRegExp(trimmedAlias)}\\b`, 'i');
    const plainMatch = plainMentionRegex.exec(content);
    if (plainMatch && plainMatch.index < bestIndex) {
      bestIndex = plainMatch.index;
    }
  }

  return bestIndex;
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
  const matches: Array<{ memberId: string; index: number }> = [];

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
      member.gateway?.name && member.runtimeAgentId
        ? `${member.runtimeAgentId} @ ${member.gateway.name}`
        : '',
      member.gateway?.name
        ? `${member.displayName} @ ${member.gateway.name}`
        : '',
    ]
      .map((item) => item.trim())
      .filter(Boolean);

    const earliestIndex = findEarliestMentionIndex(content, aliases);
    if (earliestIndex !== Number.POSITIVE_INFINITY) {
      matches.push({
        memberId: member.id,
        index: earliestIndex,
      });
    }
  }

  return matches
    .sort((left, right) => left.index - right.index)
    .map((item) => item.memberId);
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
    deliveryIntent = 'handoff';
  } else if (mentionedAll) {
    deliveryIntent = 'mention_all';
  } else if (targetMemberId) {
    deliveryIntent = senderKind === 'user' ? 'user_target' : 'ask';
  } else if (uniqueMentionedMemberIds.length > 0) {
    deliveryIntent = 'mention';
  }

  return {
    senderKind,
    mentionedMemberIds: uniqueMentionedMemberIds,
    primaryTargetMemberId,
    deliveryIntent,
    inReplyToMessageId: replyToMessageId || null,
    handoffToMemberId: handoffToMemberId || null,
    mentionedAll: Boolean(mentionedAll),
    expectedResponderMemberIds: expectedResponderMemberIds || [],
    requiredResponseMode: requiredResponseMode || (mentionedAll ? 'all' : primaryTargetMemberId ? 'any_one' : 'any_one'),
    ...(extras || {}),
  };
};
