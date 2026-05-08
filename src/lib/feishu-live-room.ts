import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';
import {
  buildLiveRoomRosterText,
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  encodeLiveRoomRoleLabel,
  extractRemoteHostIdFromRoleLabel,
  ensureLiveRoomUserMember,
  listLiveRoomCatalogAgents,
  listLiveRoomPendingReplies,
  mergeLiveRoomMentionedMemberIds,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';

export type FeishuConversationContext = {
  chatId: string;
  chatType: string;
  senderOpenId: string;
  messageId: string;
  mentionNames?: string[];
};

type FeishuConversationBindingRow = {
  id: string;
  scopeKey: string;
  chatId: string;
  chatType: string;
  senderOpenId: string | null;
  latestMessageId: string | null;
  liveRoomId: string;
  createdAt: Date;
  updatedAt: Date;
};

function buildFeishuBindingScopeKey(context: FeishuConversationContext) {
  return context.chatType === 'p2p'
    ? `feishu:p2p:${context.chatId}`
    : `feishu:group:${context.chatId}`;
}

function resolveFeishuMentionMemberIds(args: {
  mentionNames?: string[];
  members: Array<{
    id: string;
    displayName: string;
    userNickname: string | null;
    shortAlias: string | null;
    agentNameSnapshot: string | null;
    roleLabel: string | null;
    harnessType: string | null;
    backend: string | null;
    agentRecord: {
      userNickname: string | null;
      hostname: string | null;
    } | null;
    gateway: {
      name: string | null;
    } | null;
  }>;
  senderMemberId?: string | null;
}) {
  const normalizedMentionNames = (args.mentionNames || [])
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  if (normalizedMentionNames.length === 0) {
    return [];
  }

  const ids: string[] = [];
  for (const member of args.members) {
    if (member.id === args.senderMemberId) {
      continue;
    }

    const aliases = new Set(
      [member.displayName, member.userNickname, member.shortAlias, member.agentNameSnapshot, member.roleLabel, member.agentRecord?.userNickname]
        .map((value) => value?.trim().toLowerCase())
        .filter((value): value is string => !!value)
    );

    if (normalizedMentionNames.some((name) => aliases.has(name))) {
      ids.push(member.id);
    }
  }

  return ids;
}

function normalizeSelectedAgentIds(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildDefaultRoomTitle(context: FeishuConversationContext, fallbackTitle?: string) {
  if (fallbackTitle?.trim()) {
    return fallbackTitle.trim();
  }

  if (context.chatType === 'p2p') {
    return `Feishu DM ${context.chatId.slice(-6)}`;
  }

  return `Feishu Group ${context.chatId.slice(-6)}`;
}

async function addAgentsToLiveRoom(roomId: string, selectedAgentIds: string[]) {
  if (selectedAgentIds.length === 0) {
    return [];
  }

  const availableAgents = await listLiveRoomCatalogAgents();
  const selectedAgents = availableAgents.filter((agent) => selectedAgentIds.includes(agent.id));

  if (selectedAgents.length !== selectedAgentIds.length) {
    const foundIds = new Set(selectedAgents.map((agent) => agent.id));
    const missingIds = selectedAgentIds.filter((id) => !foundIds.has(id));
    throw new Error(`Unknown agent ids: ${missingIds.join(', ')}`);
  }

  const existingMembers = await prisma.liveRoomMember.findMany({
    where: { roomId },
  });

  const maxSort = await prisma.liveRoomMember.aggregate({
    where: { roomId },
    _max: { sortOrder: true },
  });
  let nextSortOrder = (maxSort._max.sortOrder || 0) + 1;

  const createdMembers = [] as Awaited<ReturnType<typeof prisma.liveRoomMember.create>>[];

  for (const agent of selectedAgents) {
    const existing = existingMembers.find((member) => {
      if (member.agentRecordId !== (agent.agentRecordId || null)) return false;
      if (member.backend !== agent.backend) return false;
      if (member.harnessType !== agent.harnessType) return false;
      if (member.runtimeAgentId !== (agent.runtimeAgentId || null)) return false;
      if (agent.backend === 'remote_ssh') {
        return extractRemoteHostIdFromRoleLabel(member.roleLabel) === agent.gatewayId;
      }
      return member.gatewayId === (agent.gatewayId === 'platform-local' ? null : agent.gatewayId);
    });

    if (existing) {
      continue;
    }

    const created = await prisma.liveRoomMember.create({
      data: {
        roomId,
        agentRecordId: agent.agentRecordId || null,
        gatewayId:
          agent.backend === 'gateway_openclaw'
            ? (agent.gatewayId === 'platform-local' ? null : agent.gatewayId)
            : null,
        memberType:
          agent.backend === 'gateway_openclaw'
            ? 'gateway_agent'
            : agent.backend === 'remote_ssh'
            ? 'remote_agent'
            : 'local_agent',
        displayName: agent.userNickname || agent.agentName || agent.label,
        agentNameSnapshot: agent.userNickname || agent.agentName || agent.label,
        harnessType: agent.harnessType,
        backend: agent.backend,
        runtimeAgentId: agent.runtimeAgentId || null,
        roleLabel: encodeLiveRoomRoleLabel({
          backend: agent.backend,
          label: agent.label,
          remoteHostId: agent.backend === 'remote_ssh' ? agent.gatewayId : null,
        }),
        joinStatus: 'joined',
        presenceStatus: agent.status === 'online' ? 'online' : 'idle',
        canReply: true,
        sortOrder: nextSortOrder++,
      },
    });

    createdMembers.push(created);
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { currentSpeakerMemberId: true },
  });

  if (createdMembers.length > 0 && room && !room.currentSpeakerMemberId) {
    await prisma.liveRoom.update({
      where: { id: roomId },
      data: {
        currentSpeakerMemberId: createdMembers[0].id,
      },
    });
  }

  return createdMembers;
}

export async function ensureFeishuConversationBinding(args: {
  context: FeishuConversationContext;
  selectedAgentIds?: string[];
  title?: string;
  topic?: string;
  workingDirectory?: string;
  permissionConfig?: AcpxPermissionConfig;
}) {
  const scopeKey = buildFeishuBindingScopeKey(args.context);
  const selectedAgentIds = args.selectedAgentIds || [];

  const existingRows = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT
      "id",
      "scopeKey",
      "chatId",
      "chatType",
      "senderOpenId",
      "latestMessageId",
      "liveRoomId",
      "createdAt",
      "updatedAt"
    FROM "FeishuConversationBinding"
    WHERE "scopeKey" = ${scopeKey}
    LIMIT 1
  `;
  const existing = existingRows[0] || null;

  if (existing) {
    const room = await prisma.liveRoom.findUnique({
      where: { id: existing.liveRoomId },
      select: { title: true },
    });
    if (!room) {
      throw new Error(`Bound live room not found: ${existing.liveRoomId}`);
    }

    const createdMembers = await addAgentsToLiveRoom(existing.liveRoomId, selectedAgentIds);
    if (createdMembers.length > 0) {
      await syncLiveRoomSourceTask(existing.liveRoomId);
    }

    if (args.permissionConfig) {
      const roomWithTask = await prisma.liveRoom.findUnique({
        where: { id: existing.liveRoomId },
        select: { sourceTaskId: true },
      });
      if (roomWithTask?.sourceTaskId) {
        await prisma.task.update({
          where: { id: roomWithTask.sourceTaskId },
          data: {
            acpxPermissionConfig: JSON.stringify(args.permissionConfig),
          },
        });
      }
    }

    const requestedWorkingDirectory = args.workingDirectory?.trim();
    if (requestedWorkingDirectory) {
      await prisma.$executeRaw`
        UPDATE "LiveRoom"
        SET "workingDirectory" = ${requestedWorkingDirectory}
        WHERE "id" = ${existing.liveRoomId}
      `;
    }

    await prisma.$executeRaw`
      UPDATE "FeishuConversationBinding"
      SET "latestMessageId" = ${args.context.messageId}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${existing.id}
    `;

    return {
      bindingId: existing.id,
      liveRoomId: existing.liveRoomId,
      roomTitle: room.title,
      created: false,
      addedAgentCount: createdMembers.length,
    };
  }

  if (selectedAgentIds.length === 0) {
    throw new Error('No live room binding exists for this Feishu chat. Create one first with /ap room --agents=<agentId1,agentId2>.');
  }

  const room = await prisma.liveRoom.create({
    data: {
      title: buildDefaultRoomTitle(args.context, args.title),
      description: `Bound to Feishu ${args.context.chatType} chat ${args.context.chatId}`,
      currentTopic: args.topic?.trim() || null,
      mode: 'discussion',
      status: 'active',
      createdBy: 'feishu',
    },
  });

  const requestedWorkingDirectory = args.workingDirectory?.trim();
  if (requestedWorkingDirectory) {
    await prisma.$executeRaw`
      UPDATE "LiveRoom"
      SET "workingDirectory" = ${requestedWorkingDirectory}
      WHERE "id" = ${room.id}
    `;
  }

  const userMember = await ensureLiveRoomUserMember(room.id);
  const createdMembers = await addAgentsToLiveRoom(room.id, selectedAgentIds);

  const bindingId = crypto.randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "FeishuConversationBinding" (
      "id",
      "scopeKey",
      "chatId",
      "chatType",
      "senderOpenId",
      "latestMessageId",
      "liveRoomId",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${bindingId},
      ${scopeKey},
      ${args.context.chatId},
      ${args.context.chatType},
      ${args.context.senderOpenId},
      ${args.context.messageId},
      ${room.id},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `;

  await syncLiveRoomSourceTask(room.id);

  if (args.permissionConfig) {
    const roomWithTask = await prisma.liveRoom.findUnique({
      where: { id: room.id },
      select: { sourceTaskId: true },
    });
    if (roomWithTask?.sourceTaskId) {
      await prisma.task.update({
        where: { id: roomWithTask.sourceTaskId },
        data: {
          acpxPermissionConfig: JSON.stringify(args.permissionConfig),
        },
      });
    }
  }

  const rosterMembers = await prisma.liveRoomMember.findMany({
    where: { roomId: room.id },
    include: {
      gateway: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  });

  await postLiveRoomMessage({
    roomId: room.id,
    content: args.topic?.trim()
      ? `Feishu 会话已绑定到该房间。当前 topic：${args.topic?.trim()}`
      : 'Feishu 会话已绑定到该房间。',
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        source: 'feishu',
        feishuChatId: args.context.chatId,
        createdBy: userMember.id,
      },
    }),
  });

  await postLiveRoomMessage({
    roomId: room.id,
    content: `当前房间成员：\n${buildLiveRoomRosterText(rosterMembers)}`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        source: 'feishu',
        systemEvent: 'room_roster',
        memberCount: rosterMembers.length,
      },
    }),
  });

  return {
    bindingId: scopeKey,
    liveRoomId: room.id,
    roomTitle: room.title,
    created: true,
    addedAgentCount: createdMembers.length,
  };
}

export async function postFeishuMessageToBoundLiveRoom(args: {
  context: FeishuConversationContext;
  content: string;
}) {
  const scopeKey = buildFeishuBindingScopeKey(args.context);
  const bindingRows = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT
      "id",
      "scopeKey",
      "chatId",
      "chatType",
      "senderOpenId",
      "latestMessageId",
      "liveRoomId",
      "createdAt",
      "updatedAt"
    FROM "FeishuConversationBinding"
    WHERE "scopeKey" = ${scopeKey}
    LIMIT 1
  `;
  const binding = bindingRows[0] || null;

  if (!binding) {
    throw new Error('This Feishu chat is not bound to a live room yet. Use /ap room --agents=<agentId1,agentId2> first.');
  }

  const userMember = await ensureLiveRoomUserMember(binding.liveRoomId);
  await syncLiveRoomSourceTask(binding.liveRoomId);

  const roomMembers = await prisma.liveRoomMember.findMany({
    where: { roomId: binding.liveRoomId },
    include: {
      agentRecord: true,
      gateway: true,
    },
  });

  const mentionedAll = detectLiveRoomMentionAll(args.content);
  const expectedResponderMemberIds = mentionedAll
    ? roomMembers.filter((member) => member.canReply && member.id !== userMember.id).map((member) => member.id)
    : [];
  const detectionResult = detectMentionedLiveRoomMembers({
    content: args.content,
    members: roomMembers,
    senderMemberId: userMember.id,
  });
  const explicitMentionMemberIds = resolveFeishuMentionMemberIds({
    mentionNames: args.context.mentionNames,
    members: roomMembers,
    senderMemberId: userMember.id,
  });
  const mentionedMemberIds = mergeLiveRoomMentionedMemberIds({
    explicitMentionMemberIds,
    detectedMentionedMemberIds: mentionedAll
      ? expectedResponderMemberIds
      : detectionResult.matchType === 'explicit'
      ? detectionResult.memberIds
      : [],
    members: roomMembers,
    senderMemberId: userMember.id,
  });
  const resolvedTargetMemberId = mentionedAll ? '' : (mentionedMemberIds[0] || '');

  const message = await postLiveRoomMessage({
    roomId: binding.liveRoomId,
    senderMemberId: userMember.id,
    content: args.content,
    messageType: 'user',
    matchedAlias: detectionResult.primaryMatchedAlias,
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'user',
      targetMemberId: resolvedTargetMemberId || null,
      mentionedMemberIds,
      mentionedAll,
      expectedResponderMemberIds,
      extras: {
        source: 'feishu',
        feishuChatId: args.context.chatId,
        feishuMessageId: args.context.messageId,
      },
    }),
  });

  void triggerLiveRoomMessageReplies({
    roomId: binding.liveRoomId,
    roomMessageId: message.id,
    requestedTargetMemberId: resolvedTargetMemberId || null,
  }).catch((error) => {
    console.error('Failed to trigger Feishu live room auto reply:', error);
  });

  await prisma.$executeRaw`
    UPDATE "FeishuConversationBinding"
    SET "latestMessageId" = ${args.context.messageId}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${binding.id}
  `;

  const pendingReplies = await listLiveRoomPendingReplies(binding.liveRoomId);
  const targetedMembers = roomMembers
    .filter((member) => mentionedAll || mentionedMemberIds.includes(member.id))
    .filter((member) => member.canReply)
    .map((member) => ({
      memberId: member.id,
      displayName: member.displayName,
    }));

  return {
    liveRoomId: binding.liveRoomId,
    targetedMembers,
    mentionedAll,
    pendingReplies,
  };
}

export function parseFeishuSelectedAgentIds(value?: string) {
  return normalizeSelectedAgentIds(value);
}

/**
 * If a regular (non-command) message arrives in a Feishu chat that is already
 * bound to a live room, relay it into the room and trigger agent replies.
 * Returns true when the message was handled, false when there is no binding.
 */
export async function tryRelayNonCommandToLiveRoom(args: {
  context: FeishuConversationContext;
  content: string;
  typingReactionId?: string;
}): Promise<boolean> {
  const scopeKey = buildFeishuBindingScopeKey(args.context);
  const bindingRows = await prisma.$queryRaw<FeishuConversationBindingRow[]>`
    SELECT
      "id", "scopeKey", "chatId", "chatType", "senderOpenId",
      "latestMessageId", "liveRoomId", "createdAt", "updatedAt"
    FROM "FeishuConversationBinding"
    WHERE "scopeKey" = ${scopeKey}
    LIMIT 1
  `;
  if (!bindingRows[0]) {
    return false;
  }

  // Persist typing reaction so the relay process can clean it up after agent replies
  if (args.typingReactionId) {
    await prisma.$executeRaw`
      UPDATE "FeishuConversationBinding"
      SET "typingReactionId" = ${args.typingReactionId},
          "typingForMessageId" = ${args.context.messageId},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${bindingRows[0].id}
    `;
  }

  await postFeishuMessageToBoundLiveRoom({
    context: args.context,
    content: args.content,
  });
  return true;
}
