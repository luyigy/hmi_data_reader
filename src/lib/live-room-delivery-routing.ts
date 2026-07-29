import { prisma } from '@/lib/prisma';
import {
  addCatalogAgentsToLiveRoom,
  detectMentionedLiveRoomMembers,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomAgentSelectors,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { orderMembersByRole, shouldRunRoleQueue } from '@/lib/live-room-scheduling';
import { stripLeadingMentionForTarget } from '@/lib/live-room-protocol';

export type DeliveryRoomMember = {
  id: string;
  canReply: boolean;
  displayName: string;
  memberType?: string;
  userNickname?: string | null;
  shortAlias?: string | null;
  agentNameSnapshot?: string | null;
  backend: string | null;
  harnessType: string | null;
  runtimeAgentId: string | null;
  gatewayId: string | null;
  roleLabel?: string | null;
  role?: string | null;
  sortOrder?: number;
  acpxPermissionConfig?: string | null;
  codexModel?: string | null;
  codexReasoningEffort?: string | null;
  gateway?: { name: string } | null;
  agentRecord?: { runtimeAgentId: string | null } | null;
};
export type DeliveryRoom = {
  id: string;
  title: string;
  currentTopic: string | null;
  mode: string;
  currentSpeakerMemberId: string | null;
  members: DeliveryRoomMember[];
};

type LiveRoomControlAction =
  | {
      action: 'add_members';
      agents: string[];
    };

const getSessionKey = (roomId: string, memberId: string) => `live-room:${roomId}:member:${memberId}`;

export const getPreferredDirectedAlias = (member: DeliveryRoomMember) =>
  member.userNickname
  || member.shortAlias
  || member.displayName;

const parseJsonObject = (value?: string | null) => {
  if (!value) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const LIVE_ROOM_CONTROL_BLOCK_PATTERN = /^\s*<room-control>\s*([\s\S]*?)\s*<\/room-control>\s*/i;

export const parseLiveRoomControlAction = (output: string): {
  action: LiveRoomControlAction;
  remainingOutput: string;
} | null => {
  const match = output.match(LIVE_ROOM_CONTROL_BLOCK_PATTERN);
  if (!match) {
    return null;
  }

  const remainingOutput = output.slice(match[0].length).trim();
  const parsed = parseJsonObject(match[1]);
  if (parsed.action !== 'add_members' || !Array.isArray(parsed.agents)) {
    throw new Error('Invalid room-control payload. Supported action: add_members.');
  }

  const agents = parsed.agents
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value): value is string => value.length > 0);

  if (agents.length === 0) {
    throw new Error('room-control add_members requires a non-empty agents array.');
  }

  return {
    action: {
      action: 'add_members',
      agents,
    },
    remainingOutput,
  };
};

export const executeLiveRoomControlAction = async ({
  roomId,
  actorDisplayName,
  action,
}: {
  roomId: string;
  actorDisplayName: string;
  action: LiveRoomControlAction;
}) => {
  const agentIds = await resolveLiveRoomAgentSelectors(action.agents);
  const createdMembers = await addCatalogAgentsToLiveRoom(roomId, agentIds);
  if (createdMembers.length > 0) {
    await syncLiveRoomSourceTask(roomId);
  }

  const addedNames = createdMembers.map((member) => member.displayName);
  const duplicateCount = agentIds.length - createdMembers.length;
  const duplicateSuffix = duplicateCount > 0 ? `；已存在 ${duplicateCount} 个` : '';

  await postLiveRoomMessage({
    roomId,
    content:
      createdMembers.length > 0
        ? `系统提示：${actorDisplayName} 已执行房间控制，新增成员：${addedNames.join('、')}${duplicateSuffix}。`
        : `系统提示：${actorDisplayName} 请求添加的成员均已在房间中。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        systemEvent: 'room_control_add_members',
        actorDisplayName,
        requestedAgentSelectors: action.agents,
        addedCount: createdMembers.length,
        duplicateCount,
      },
    }),
  });
};

const getReplyEligibleMembers = ({
  room,
  sourceSenderMemberId,
}: {
  room: DeliveryRoom | null;
  sourceSenderMemberId?: string | null;
}) => (room?.members || []).filter((member: DeliveryRoomMember) => member.canReply && member.id !== sourceSenderMemberId);

export const getPrimaryReplyTarget = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
  preferRequestedTarget = false,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
  preferRequestedTarget?: boolean;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  const targetLocked = sourceMetadata?.targetLocked === true;
  if (targetLocked) {
    const lockedCandidates = [
      requestedTargetMemberId || null,
      sourceMetadata?.primaryTargetMemberId || null,
    ].filter(Boolean) as string[];

    for (const candidate of lockedCandidates) {
      const found = eligibleMembers.find((member: DeliveryRoomMember) => member.id === candidate);
      if (found) {
        return found;
      }
    }

    return null;
  }

  const baseCandidates = [
    sourceMetadata?.deliveryIntent === 'handoff' ? sourceMetadata.handoffToMemberId : null,
    sourceMetadata?.primaryTargetMemberId || null,
    sourceMetadata?.mentionedMemberIds?.[0] || null,
    room.currentSpeakerMemberId || null,
  ].filter(Boolean) as string[];

  const candidates = preferRequestedTarget
    ? [requestedTargetMemberId || null, ...baseCandidates]
    : [...baseCandidates, requestedTargetMemberId || null];

  for (const candidate of candidates) {
    const found = eligibleMembers.find((member: DeliveryRoomMember) => member.id === candidate);
    if (found) {
      return found;
    }
  }

  return eligibleMembers[0] || null;
};

export const getTargetMemberIdsForMessage = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
  sourceContent,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
  sourceContent: string;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  const targetLocked = sourceMetadata?.targetLocked === true;
  if (targetLocked) {
    const lockedTargets = [
      requestedTargetMemberId || null,
      sourceMetadata?.primaryTargetMemberId || null,
    ]
      .filter((memberId): memberId is string => typeof memberId === 'string' && memberId.trim().length > 0)
      .filter((memberId, index, list) => list.indexOf(memberId) === index)
      .filter((memberId) => eligibleMembers.some((member: DeliveryRoomMember) => member.id === memberId));

    return lockedTargets;
  }

  if (sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll) {
    const expectedIds = (sourceMetadata.expectedResponderMemberIds || []).filter(Boolean) as string[];
    const targets = (expectedIds.length > 0 ? expectedIds : eligibleMembers.map((member: DeliveryRoomMember) => member.id))
      .filter((memberId: string, index: number, list: string[]) => list.indexOf(memberId) === index)
      .filter((memberId: string) => eligibleMembers.some((member: DeliveryRoomMember) => member.id === memberId));

    return targets;
  }

  const hasExplicitTarget = Boolean(
    requestedTargetMemberId
    || sourceMetadata?.primaryTargetMemberId
    || sourceMetadata?.mentionedMemberIds?.length
  );
  if (!hasExplicitTarget && shouldRunRoleQueue(room.mode, sourceContent)) {
    return orderMembersByRole(eligibleMembers).map((member) => member.id);
  }

  const primaryTarget = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
  });

  return primaryTarget ? [primaryTarget.id] : [];
};

export const ensureMemberSession = async (roomId: string, member: {
  id: string;
  backend: string | null;
  harnessType: string | null;
}) => {
  const existing = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.liveRoomMemberSession.create({
    data: {
      roomId,
      memberId: member.id,
      backend: member.backend || 'platform_local',
      sessionKey: getSessionKey(roomId, member.id),
      status: 'online',
      supportsStreaming: member.backend === 'platform_local',
      supportsAppendMessage: true,
      supportsInterrupt: member.harnessType === 'codex' || member.backend === 'remote_ssh',
    },
  });
};

export const inferDirectedVisibleRelayTarget = ({
  room,
  sourceMessage,
  currentTargetMember,
}: {
  room: DeliveryRoom;
  sourceMessage: {
    content: string;
    senderMember?: {
      id: string;
      displayName: string;
      memberType: string;
    } | null;
  };
  currentTargetMember: DeliveryRoomMember;
}) => {
  if (sourceMessage.senderMember?.memberType !== 'user') {
    return null;
  }

  const stripped = stripLeadingMentionForTarget({
    content: sourceMessage.content,
    targetDisplayName: currentTargetMember.displayName,
  });

  if (!stripped || stripped === sourceMessage.content) {
    return null;
  }

  const detection = detectMentionedLiveRoomMembers({
    content: stripped,
    members: room.members.filter((member) => member.canReply && member.id !== currentTargetMember.id),
    senderMemberId: sourceMessage.senderMember?.id || null,
  });

  if (detection.memberIds.length !== 1) {
    return null;
  }

  return room.members.find((member) => member.id === detection.memberIds[0]) || null;
};
