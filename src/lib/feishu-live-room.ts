import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';
import {
  addCatalogAgentsToLiveRoom,
  buildLiveRoomRosterText,
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  ensureLiveRoomUserMember,
  listLiveRoomCatalogAgents,
  listLiveRoomPendingReplies,
  mergeLiveRoomMentionedMemberIds,
  postLiveRoomMessage,
  resolveLiveRoomAgentSelectors,
  resolveDocumentationTarget,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { getFeishuChatInfo } from '@/lib/feishu-api';
import { resolveFeishuTaskConversation } from '@/lib/feishu-task-binding';
import type { PrismaClient } from '@prisma/client';
import type { LiveRoomMode } from '@/lib/live-room-scheduling';

export type FeishuConversationContext = {
  appId?: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  messageId: string;
  mentionNames?: string[];
  // Topic identity comes from the verified im.message.receive_v1 payload:
  // thread_id / root_id / parent_id are distinct fields and never interchangeable.
  threadId?: string;
  rootId?: string;
  parentMessageId?: string;
};

export const UNBOUND_FEISHU_LIVE_ROOM_HINT = '当前会话尚未绑定 Live Room，普通消息不会转发给 agent。确认创建独立房间请发送 `/ap room --workdir=<目录>`；该命令会加入默认本机 Codex。也可用 `/ap agents` 指定成员。';

export const UNKNOWN_FEISHU_TOPIC_HINT = '当前话题未绑定任务；消息不会回退到群房间或其他任务。请回到任务所属话题继续，或在群根会话操作。';

export const ARCHIVED_FEISHU_TASK_HINT = '该任务已归档，不会隐式恢复执行；如需继续请先联系管理员恢复任务。';

export class FeishuUnknownTopicError extends Error {
  constructor() {
    super(UNKNOWN_FEISHU_TOPIC_HINT);
    this.name = 'FeishuUnknownTopicError';
  }
}

export class FeishuArchivedTaskError extends Error {
  constructor() {
    super(ARCHIVED_FEISHU_TASK_HINT);
    this.name = 'FeishuArchivedTaskError';
  }
}

// NOTE: ts-node runs this file at an ES5 downlevel target where `instanceof`
// against Error subclasses is unreliable (super.call returns a fresh Error), so
// rejection detection is name-based and works in both compile targets.
export const isFeishuTopicRejection = (error: unknown) => {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === 'FeishuUnknownTopicError' || name === 'FeishuArchivedTaskError';
};

export function resolveNewFeishuRoomWorkingDirectory(args: {
  chatType: string;
  confirmCreate?: boolean;
  requestedWorkingDirectory?: string;
  workspaceRoot?: string | null;
}) {
  if (args.chatType !== 'group') {
    return args.requestedWorkingDirectory || args.workspaceRoot;
  }
  if (!args.confirmCreate) {
    throw new Error('请先使用 /ap room --workdir=<目录> 明确确认创建该群的独立 Live Room。');
  }
  if (!args.requestedWorkingDirectory) {
    throw new Error('创建群 Live Room 必须通过 /ap room --workdir=<目录> 显式设置工作目录。');
  }
  return args.requestedWorkingDirectory;
}

export function hasFeishuTopicIdentity(context: FeishuConversationContext) {
  return context.chatType === 'group'
    && !!(context.threadId || context.rootId || context.parentMessageId);
}

export type FeishuConversationBindingRow = {
  id: string;
  appId: string | null;
  scopeKey: string;
  chatId: string;
  chatType: string;
  threadId: string | null;
  rootMessageId: string | null;
  senderOpenId: string | null;
  latestMessageId: string | null;
  liveRoomId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type FeishuConversationTarget =
  | { kind: 'group_entry'; binding: FeishuConversationBindingRow | null }
  | { kind: 'task' | 'archived_task'; binding: FeishuConversationBindingRow }
  | { kind: 'unknown_topic' };

/** Single routing entry for every Feishu input/control channel. Group messages
 *  without topic identity keep the legacy scopeKey lookup; group messages with
 *  topic identity must resolve through the S01 task resolver and NEVER fall back
 *  to the group binding (unknown topics are rejected, archived tasks surfaced). */
export async function resolveFeishuConversationTarget(
  context: FeishuConversationContext,
  db: PrismaClient = prisma,
): Promise<FeishuConversationTarget> {
  if (!hasFeishuTopicIdentity(context)) {
    const scopeKey = buildFeishuBindingScopeKey(context);
    const bindingRows = await db.$queryRaw<FeishuConversationBindingRow[]>`
      SELECT
        "id", "appId", "scopeKey", "chatId", "chatType", "threadId", "rootMessageId",
        "senderOpenId", "latestMessageId", "liveRoomId", "createdAt", "updatedAt"
      FROM "FeishuConversationBinding"
      WHERE "scopeKey" = ${scopeKey}
      LIMIT 1
    `;
    return { kind: 'group_entry', binding: bindingRows[0] || null };
  }

  const resolved = await resolveFeishuTaskConversation({
    appId: context.appId || process.env.FEISHU_APP_ID || '',
    chatId: context.chatId,
    chatType: 'group',
    threadId: context.threadId,
    rootMessageId: context.rootId,
    parentMessageId: context.parentMessageId,
  }, db);
  if (resolved.kind === 'unknown_topic') return { kind: 'unknown_topic' };
  return { kind: resolved.kind, binding: resolved.binding as FeishuConversationBindingRow };
}

/** Server-side mapping check for card actions: a room may only be controlled from
 *  a chat that holds a binding for it. Task rows must additionally match the
 *  current app identity; legacy rows (NULL appId) stay readable by this app. */
export async function isFeishuRoomBoundToChat(args: {
  roomId: string;
  chatId: string;
  appId?: string;
}, db: PrismaClient = prisma) {
  const appId = args.appId || process.env.FEISHU_APP_ID || null;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "FeishuConversationBinding"
    WHERE "liveRoomId" = ${args.roomId}
      AND "chatId" = ${args.chatId}
      AND ("appId" IS NULL OR "appId" = ${appId})
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function getBoundLiveRoomId(context?: FeishuConversationContext): Promise<string | null> {
  if (!context) return null;
  const target = await resolveFeishuConversationTarget(context);
  if (target.kind === 'unknown_topic') throw new FeishuUnknownTopicError();
  if (target.kind === 'archived_task') throw new FeishuArchivedTaskError();
  return target.binding?.liveRoomId ?? null;
}

export async function getBoundSourceTaskId(context?: FeishuConversationContext): Promise<string | null> {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) return null;

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { sourceTaskId: true },
  });

  return room?.sourceTaskId ?? null;
}

export async function getBoundLiveRoom(context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) return null;

  return prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });
}

export function resolveRoomMemberQuery(args: {
  room: NonNullable<Awaited<ReturnType<typeof getBoundLiveRoom>>>;
  query?: string | null;
}) {
  const normalizedQuery = args.query?.trim().replace(/^[@$]/, '').toLowerCase() || '';
  const replyableMembers = args.room.members.filter((member) => member.memberType !== 'user' && member.canReply);

  if (!normalizedQuery) {
    return (
      replyableMembers.find((member) => member.id === args.room.currentSpeakerMemberId)
      || replyableMembers[0]
      || null
    );
  }

  return replyableMembers.find((member) =>
    `${member.displayName} [${member.id.slice(-8)}]`.toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase() === normalizedQuery
    || (member.userNickname || '').toLowerCase() === normalizedQuery
    || (member.shortAlias || '').toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase().includes(normalizedQuery)
    || member.id.endsWith(normalizedQuery)
  ) || null;
}

type LegacyFeishuBindingRow = {
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

function pickDefaultFeishuBindingAgent(agents: Awaited<ReturnType<typeof listLiveRoomCatalogAgents>>) {
  return agents.find((agent) => agent.backend === 'platform_local' && agent.harnessType === 'codex')
    || agents.find((agent) => agent.backend === 'platform_local' && agent.harnessType === 'pi-agent')
    || agents.find((agent) => agent.backend === 'platform_local')
    || agents[0]
    || null;
}

async function buildDefaultRoomTitle(context: FeishuConversationContext, fallbackTitle?: string) {
  if (fallbackTitle?.trim()) {
    return fallbackTitle.trim();
  }

  if (context.chatType === 'group') {
    const info = await getFeishuChatInfo(context.chatId);
    if (info?.name) {
      return info.name;
    }
  }

  if (context.chatType === 'p2p') {
    return `Feishu DM ${context.chatId.slice(-6)}`;
  }

  return `Feishu Group ${context.chatId.slice(-6)}`;
}

export async function ensureFeishuConversationBinding(args: {
  context: FeishuConversationContext;
  selectedAgentIds?: string[];
  title?: string;
  topic?: string;
  workingDirectory?: string;
  workspaceRoot?: string;
  permissionConfig?: AcpxPermissionConfig;
  mode?: LiveRoomMode;
  allowDefaultAgent?: boolean;
  confirmCreate?: boolean;
}) {
  const { resolveWorkspaceDirectory } = await import('@/lib/feishu-workspace');
  const access = args.context.chatType === 'p2p'
    ? await prisma.feishuUserAccess.findUnique({ where: { openId: args.context.senderOpenId }, select: { workspaceRoot: true } })
    : null;
  const workspaceRoot = args.workspaceRoot || access?.workspaceRoot;
  const requestedWorkingDirectory = workspaceRoot && (args.workingDirectory || args.workspaceRoot)
    ? await resolveWorkspaceDirectory(workspaceRoot, args.workingDirectory)
    : args.workingDirectory?.trim();
  const scopeKey = buildFeishuBindingScopeKey(args.context);
  let selectedAgentIds = args.selectedAgentIds || [];

  if (selectedAgentIds.length === 0 && args.allowDefaultAgent) {
    const agents = await listLiveRoomCatalogAgents();
    const defaultAgent = pickDefaultFeishuBindingAgent(agents);
    selectedAgentIds = defaultAgent ? [defaultAgent.id] : [];
  }

  // Topic identity routes through the task resolver: reuse the task room, or
  // reject unknown/archived topics. A group-level binding is never created or
  // adopted from inside a topic thread.
  const target = await resolveFeishuConversationTarget(args.context);
  if (target.kind === 'unknown_topic') throw new FeishuUnknownTopicError();
  if (target.kind === 'archived_task') throw new FeishuArchivedTaskError();
  const existing: LegacyFeishuBindingRow | null = target.binding;

  if (existing) {
    const room = await prisma.liveRoom.findUnique({
      where: { id: existing.liveRoomId },
      select: { title: true, mode: true },
    });
    if (!room) {
      throw new Error(`Bound live room not found: ${existing.liveRoomId}`);
    }

    if (args.mode) {
      await prisma.liveRoom.update({
        where: { id: existing.liveRoomId },
        data: { mode: args.mode },
      });
    }

    const createdMembers = await addCatalogAgentsToLiveRoom(existing.liveRoomId, selectedAgentIds);
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
      roomMode: args.mode || room.mode,
      created: false,
      addedAgentCount: createdMembers.length,
    };
  }

  if (selectedAgentIds.length === 0) {
    throw new Error('No live room binding exists for this Feishu chat. Create one first with /ap room --agents=<agentId1,agentId2>.');
  }

  const initialWorkingDirectory = resolveNewFeishuRoomWorkingDirectory({
    chatType: args.context.chatType,
    confirmCreate: args.confirmCreate,
    requestedWorkingDirectory,
    workspaceRoot,
  });

  const room = await prisma.liveRoom.create({
    data: {
      title: await buildDefaultRoomTitle(args.context, args.title),
      description: `Bound to Feishu ${args.context.chatType} chat ${args.context.chatId}`,
      currentTopic: args.topic?.trim() || null,
      mode: args.mode || 'discussion',
      status: 'active',
      createdBy: 'feishu',
    },
  });

  if (initialWorkingDirectory) {
    await prisma.$executeRaw`
      UPDATE "LiveRoom"
      SET "workingDirectory" = ${initialWorkingDirectory}
      WHERE "id" = ${room.id}
    `;
  }

  const userMember = await ensureLiveRoomUserMember(room.id);
  const createdMembers = await addCatalogAgentsToLiveRoom(room.id, selectedAgentIds);

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
        feishuBindingId: bindingId,
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
    roomMode: room.mode,
    created: true,
    addedAgentCount: createdMembers.length,
  };
}

export async function setFeishuBoundRoomMode(
  context: FeishuConversationContext,
  mode: LiveRoomMode
) {
  const target = await resolveFeishuConversationTarget(context);
  if (target.kind === 'unknown_topic') throw new FeishuUnknownTopicError();
  if (target.kind === 'archived_task') throw new FeishuArchivedTaskError();
  if (!target.binding) {
    throw new Error('当前 Feishu 会话尚未绑定 Live Room。请先使用 /ap room 创建绑定。');
  }

  const room = await prisma.liveRoom.update({
    where: { id: target.binding.liveRoomId },
    data: { mode },
    select: { id: true, title: true, mode: true },
  });
  return room;
}

export async function postFeishuMessageToBoundLiveRoom(args: {
  context: FeishuConversationContext;
  content: string;
}) {
  const target = await resolveFeishuConversationTarget(args.context);
  if (target.kind === 'unknown_topic') throw new FeishuUnknownTopicError();
  if (target.kind === 'archived_task') throw new FeishuArchivedTaskError();
  const binding = target.binding;

  if (!binding) {
    throw new Error('This Feishu chat is not bound to a live room yet. Use /ap room --agents=<agentId1,agentId2> first.');
  }

  if (args.context.messageId) {
    const existingMessage = await prisma.liveRoomMessage.findFirst({
      where: {
        roomId: binding.liveRoomId,
        metadata: {
          contains: `"feishuMessageId":"${args.context.messageId}"`,
        },
      },
      select: { id: true },
    });
    if (existingMessage) {
      const roomMembers = await prisma.liveRoomMember.findMany({
        where: { roomId: binding.liveRoomId },
      });
      return {
        liveRoomId: binding.liveRoomId,
        targetedMembers: [],
        mentionedAll: false,
        pendingReplies: [],
      };
    }
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

  const { specialist: documentationSpecialist, targetMemberId: effectiveTargetMemberId } = resolveDocumentationTarget({
    content: args.content,
    mentionedAll,
    resolvedTargetMemberId,
    members: roomMembers,
  });

  const message = await postLiveRoomMessage({
    roomId: binding.liveRoomId,
    senderMemberId: userMember.id,
    content: args.content,
    messageType: 'user',
    matchedAlias: detectionResult.primaryMatchedAlias,
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'user',
      targetMemberId: effectiveTargetMemberId || null,
      mentionedMemberIds,
      mentionedAll,
      expectedResponderMemberIds,
      extras: {
        source: 'feishu',
        feishuBindingId: binding.id,
        feishuChatId: args.context.chatId,
        feishuMessageId: args.context.messageId,
        targetLocked: explicitMentionMemberIds.length === 1 && !mentionedAll,
        targetResolutionSource: documentationSpecialist
          ? 'specialty_documentation'
          : explicitMentionMemberIds.length > 0 ? 'feishu_structured_mention' : null,
        ...(documentationSpecialist ? { specialtyRoute: 'documentation' } : {}),
      },
    }),
  });

  void triggerLiveRoomMessageReplies({
    roomId: binding.liveRoomId,
    roomMessageId: message.id,
    requestedTargetMemberId: effectiveTargetMemberId || null,
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
    .filter((member) => documentationSpecialist
      ? member.id === effectiveTargetMemberId
      : mentionedAll || mentionedMemberIds.includes(member.id))
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

export async function resolveDefaultFeishuBindingAgentIds(): Promise<string[]> {
  const agents = await listLiveRoomCatalogAgents();
  const defaultAgent = pickDefaultFeishuBindingAgent(agents);
  return defaultAgent ? [defaultAgent.id] : [];
}

export async function resolveFeishuSelectedAgentIds(value?: string): Promise<string[]> {
  return resolveLiveRoomAgentSelectors(normalizeSelectedAgentIds(value));
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
  const target = await resolveFeishuConversationTarget(args.context);
  if (target.kind === 'unknown_topic') throw new FeishuUnknownTopicError();
  if (target.kind === 'archived_task') throw new FeishuArchivedTaskError();
  if (!target.binding) {
    return false;
  }

  // Persist typing reaction so the relay process can clean it up after agent replies
  if (args.typingReactionId) {
    await prisma.$executeRaw`
      UPDATE "FeishuConversationBinding"
      SET "typingReactionId" = ${args.typingReactionId},
          "typingForMessageId" = ${args.context.messageId},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.binding.id}
    `;
  }

  await postFeishuMessageToBoundLiveRoom({
    context: args.context,
    content: args.content,
  });
  return true;
}
