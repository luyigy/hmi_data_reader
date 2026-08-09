import { prisma } from "@/lib/prisma";
import { getSocketServer } from "@/lib/websocket";
import { ensureTaskChatRoom, postTaskRoomMessage } from "@/lib/task-room";
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from "@/lib/task-room-targets";
import { getMentionAliases, type LiveRoomMemberWithAgent } from "@/lib/agent-identity";
import { relayLiveRoomMessageToFeishu } from "@/lib/feishu-live-room-relay";
import { redactSensitiveText, redactSensitiveValue } from "@/lib/redact-sensitive";
import { buildLiveRoomAcpxParticipant } from "@/lib/live-room-members";
import { extractRemoteHostIdFromRoleLabel, getLiveRoomParticipantContinuationKey, type LiveRoomDeliveryIntent, type LiveRoomMentionableMember, type LiveRoomMessageMetadata, type LiveRoomMessagePayload, type LiveRoomSummaryPayload } from "@/lib/live-room-types";

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
  const safeContent = redactSensitiveText(content);
  const safeMetadata = redactSensitiveValue(metadata) as Record<string, unknown> | null | undefined;
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
      content: safeContent,
      messageType,
      visibility,
      replyToMessageId: replyToMessageId || null,
      topicSnapshot: room?.currentTopic || null,
      metadata: safeMetadata ? JSON.stringify(safeMetadata) : null,
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
          role: targetMember.role,
          codexModel: targetMember.codexModel,
          codexReasoningEffort: targetMember.codexReasoningEffort,
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
    console.error('Failed to relay live room message to Feishu:', redactSensitiveText(String(error)));
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

/** 文档/记录类意图关键词检测。
 *  检测"写进 inbox / 出文档 / 记一下 / 写 FIX 文档 / 记录这次决定"等模式。
 *  会在剥离开头的 @/$mention 前缀后匹配，避免 @文档专员 本身被误判。 */
const DOCUMENTATION_INTENT_PATTERNS = [
  /写进\s*inbox/i,
  /(?:出|写|生成)(?:个?\s*)?(?:FIX|fix)\s*文档/i,
  /(?:出|写|生成|提交)(?:个?\s*)?(?:文档|记录|HANDOVER)/i,
  /记(?:录|一下|下来)(?:这次|这个|一下)?(?:决定|结论|讨论)/i,
  /(?:写|存|放)(?:进|到|入)\s*inbox/i,
  /(?:记录|记)\s*(?:一下|下来|这个)\b/i,
  /(?:整理|汇总)(?:一下|个?)?\s*(?:文档|记录)/i,
];

const DOCUMENTATION_SPECIALTY_OVERRIDE = /(?:亲自|你自己|直接)(?:来)?(?:写|整理|记录|提交)/;

export const detectDocumentationIntent = (content: string): boolean => {
  // 剥离开头的 @mention / $mention 前缀，避免把提及本身当作意图
  const stripped = content.replace(/^[@$][^\s]+\s*/, '').trim();
  return DOCUMENTATION_INTENT_PATTERNS.some((pattern) => pattern.test(stripped));
};

/** 在成员列表中查找文档专员（specialty === 'documentation' 且 canReply） */
export const findDocumentationSpecialist = <T extends { id: string; canReply?: boolean; specialty?: string | null }>(
  members: T[],
): T | null => {
  return members.find(
    (member) => member.canReply && member.specialty === 'documentation'
  ) || null;
};

export const resolveDocumentationTarget = <T extends { id: string; canReply?: boolean; specialty?: string | null }>({
  content,
  mentionedAll,
  resolvedTargetMemberId,
  members,
}: {
  content: string;
  mentionedAll: boolean;
  resolvedTargetMemberId?: string | null;
  members: T[];
}) => {
  const specialist = !mentionedAll
    && !DOCUMENTATION_SPECIALTY_OVERRIDE.test(content)
    && detectDocumentationIntent(content)
    ? findDocumentationSpecialist(members)
    : null;
  return { specialist, targetMemberId: specialist?.id || resolvedTargetMemberId || null };
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
