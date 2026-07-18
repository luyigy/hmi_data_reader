import { prisma } from '@/lib/prisma';
import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { findLatestParticipantSession, parseAcpxMetadata } from '@/lib/acpx/session-tracking';
import { requestRunControl } from '@/lib/acpx/process-registry';
import { getHarnessAdapter } from '@/lib/harness';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import {
  clearLiveRoomRunningProcess,
  enqueueLiveRoomMemberExecution,
  getLiveRoomRunningProcess,
  interruptLiveRoomRunningProcess,
} from '@/lib/live-room-process-registry';
import {
  addCatalogAgentsToLiveRoom,
  buildLiveRoomAcpxParticipant,
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  extractRemoteHostIdFromRoleLabel,
  getLiveRoomParticipantContinuationKey,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomAgentSelectors,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import type { AcpxPermissionConfig, HarnessStreamCallbacks } from '@/lib/acpx/types';
import { FeishuProgressTracker } from '@/lib/feishu-progress';
import { orderMembersByRole, shouldRunRoleQueue } from '@/lib/live-room-scheduling';
import {
  buildLiveRoomContinuationMessage,
  buildLiveRoomControlManual,
  stripLeadingMentionForTarget,
} from '@/lib/live-room-protocol';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ALL_REPLY_STAGGER_MS = 750;
const REMOTE_STALE_GRACE_MS = 30 * 1000;
const REMOTE_STALE_AFTER_MS = DEFAULT_TIMEOUT_MS + REMOTE_STALE_GRACE_MS;
const SSH_WARNING_PATTERNS = [
  /^Warning: Permanently added .*known hosts\.\s*$/gim,
  // WSL startup message (UTF-16LE encoded, sent as stderr by Windows SSH+WSL)
  /^wsl:.*$/gim,
];
const CODEX_EPHEMERAL_RETRY_PATTERNS = [
  /Codex local state error:/i,
  /failed to open state db/i,
  /failed to initialize state runtime/i,
  /migration\s+\d+\s+was previously applied but is missing in the resolved migrations/i,
];

type DeliveryRoomMember = {
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

type DeliveryRoom = {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeLiveRoomExecutionError = (message: string) => {
  // Strip embedded null bytes (from WSL UTF-16LE startup messages decoded as UTF-8)
  let normalized = message.replace(/\0/g, '');

  for (const pattern of SSH_WARNING_PATTERNS) {
    normalized = normalized.replace(pattern, '').trim();
  }

  return normalized.trim() || 'Live room execution failed';
};

const getSessionKey = (roomId: string, memberId: string) => `live-room:${roomId}:member:${memberId}`;

const getPreferredDirectedAlias = (member: DeliveryRoomMember) =>
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

const stringifyJson = (value?: Record<string, unknown> | null) =>
  value ? JSON.stringify(value) : null;

const LIVE_ROOM_CONTROL_BLOCK_PATTERN = /^\s*<room-control>\s*([\s\S]*?)\s*<\/room-control>\s*/i;

const parseLiveRoomControlAction = (output: string): {
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

const executeLiveRoomControlAction = async ({
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

const getPrimaryReplyTarget = ({
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

const getTargetMemberIdsForMessage = ({
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

const ensureMemberSession = async (roomId: string, member: {
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

const inferDirectedVisibleRelayTarget = ({
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

const isInvalidContinuationError = (harnessType: string | null, message: string) => {
  return getHarnessAdapter(harnessType)?.isInvalidContinuationError?.(message) ?? false;
};

const shouldRetryWithFreshSession = ({
  harnessType,
  message,
  hasContinuation,
}: {
  harnessType: string | null;
  message: string;
  hasContinuation: boolean;
}) => {
  if (!hasContinuation) {
    return false;
  }

  if (isInvalidContinuationError(harnessType, message)) {
    return true;
  }

  return /timed out after \d+ms/i.test(message);
};

const shouldRetryCodexEphemeral = ({
  harnessType,
  message,
}: {
  harnessType: string | null;
  message: string;
}) => (
  harnessType === 'codex'
  && CODEX_EPHEMERAL_RETRY_PATTERNS.some((pattern) => pattern.test(message))
);

// Codex thread continuation is now enabled — transcript-only mode was removed because
// it silently discarded all session history on every message. Stale thread fallback
// is handled by INVALID_CODEX_CONTINUATION_PATTERNS + shouldRetryWithFreshSession.
const shouldPreferTranscriptContinuation = () => false;

const LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS = 8000;
const LIVE_ROOM_PROGRESS_MAX_PREVIEW_CHARS = 220;

const normalizeProgressPreview = (chunk: string) => {
  const trimmed = normalizeLiveRoomExecutionError(chunk)
    .replace(/<p><\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r/g, '')
    .trim();

  if (!trimmed) {
    return null;
  }

  if (/^[{\[]/.test(trimmed)) {
    return null;
  }

  const singleLine = trimmed.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return null;
  }

  return singleLine.length > LIVE_ROOM_PROGRESS_MAX_PREVIEW_CHARS
    ? `${singleLine.slice(0, LIVE_ROOM_PROGRESS_MAX_PREVIEW_CHARS - 3)}...`
    : singleLine;
};

const markParticipantContinuationStale = async ({
  participantId,
  reason,
}: {
  participantId: string;
  reason: string;
}) => {
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: {
      controlMetadata: true,
    },
  });

  if (!participant) {
    return;
  }

  const metadata = parseJsonObject(participant.controlMetadata);
  delete metadata.lastSessionId;
  delete metadata.lastSessionKind;
  delete metadata.lastSessionThreadId;
  delete metadata.codexThreadId;
  delete metadata.claudeSessionId;

  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: stringifyJson({
        ...metadata,
        continuationStaleAt: new Date().toISOString(),
        continuationStaleReason: reason,
      }),
    },
  });
};

const markLiveRoomSessionExpired = async ({
  sessionId,
  reason,
}: {
  sessionId: string;
  reason: string;
}) => {
  await prisma.liveRoomMemberSession.update({
    where: { id: sessionId },
    data: {
      threadId: null,
      status: 'expired',
      lastHeartbeatAt: new Date(),
      lastError: reason,
    },
  }).catch(() => undefined);
};

const annotateFreshRetryMetadata = async ({
  taskRunId,
  participantId,
  staleReason,
  staleParticipantId,
}: {
  taskRunId: string;
  participantId?: string;
  staleReason: string;
  staleParticipantId?: string | null;
}) => {
  const taskRun = await prisma.taskRun.findUnique({
    where: { id: taskRunId },
    select: {
      controlMetadata: true,
    },
  });

  await prisma.taskRun.update({
    where: { id: taskRunId },
    data: {
      controlMetadata: stringifyJson({
        ...parseJsonObject(taskRun?.controlMetadata),
        freshRetry: {
          used: true,
          staleReason,
          staleParticipantId: staleParticipantId || null,
          recordedAt: new Date().toISOString(),
        },
      }),
    },
  });

  if (!participantId) {
    return;
  }

  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: {
      controlMetadata: true,
    },
  });

  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: stringifyJson({
        ...parseJsonObject(participant?.controlMetadata),
        freshRetry: {
          used: true,
          staleReason,
          staleParticipantId: staleParticipantId || null,
          recordedAt: new Date().toISOString(),
        },
      }),
    },
  });
};

const runLiveRoomAcpxAttempt = async ({
  sourceTask,
  room,
  participant,
  contentForAgent,
  desiredDirectedTarget,
  permissionConfig,
  latestSession,
  useFreshSession,
  forceEphemeral = false,
  streamCallbacks,
}: {
  sourceTask: NonNullable<Awaited<ReturnType<typeof syncLiveRoomSourceTask>>>;
  room: DeliveryRoom & {
    sourceTask?: {
      id: string;
      name: string;
      description?: string | null;
      workingDirectory?: string | null;
      acpxPermissionConfig?: string | null;
      currentTaskSession?: {
        id: string;
      } | null;
    } | null;
  };
  participant: ReturnType<typeof buildLiveRoomAcpxParticipant>;
  contentForAgent: string;
  desiredDirectedTarget?: DeliveryRoomMember | null;
  permissionConfig: AcpxPermissionConfig;
  latestSession: Awaited<ReturnType<typeof findLatestParticipantSession>>;
  useFreshSession: boolean;
  forceEphemeral?: boolean;
  streamCallbacks?: HarnessStreamCallbacks;
}) => {
  const shouldUseContinuation =
    !useFreshSession
    && !forceEphemeral
    && !shouldPreferTranscriptContinuation()
    && Boolean(latestSession?.continuationSessionId);

  // Live room local codex/claude runs can be legitimately long-lived.
  // Keep the watchdog disabled only for those harnesses; pi-agent should still
  // retain the default timeout so a stuck local process doesn't look like a silent room.
  const watchdogConfig =
    participant.executionBackend === 'platform_local'
      && (participant.harnessType === 'codex' || participant.harnessType === 'claude')
      ? { maxRuntimeMs: null }
      : undefined;

  const replyableMemberLabels = room.members
    .filter((member) => member.canReply)
    .map((member) => member.displayName);
  const directedTargetAlias = desiredDirectedTarget ? getPreferredDirectedAlias(desiredDirectedTarget) : null;
  const liveRoomControlManual = buildLiveRoomControlManual({
    replyableMemberLabels,
    directedTargetAlias,
    directedTargetDisplayName: desiredDirectedTarget?.displayName || null,
  });
  const directedVisibleProtocol = [
    sourceTask.description || '',
    '',
    liveRoomControlManual,
  ].join('\n').trim();

  return executeAcpxTaskRun({
    taskId: sourceTask.id,
    taskSessionId: sourceTask.currentTaskSession?.id || undefined,
    taskName: sourceTask.name,
    taskDescription: directedVisibleProtocol || undefined,
    orchestrationMode: 'single',
    participants: [{
      ...participant,
      resumeSessionId: shouldUseContinuation ? latestSession?.continuationSessionId || undefined : undefined,
      continuationSessionKind: shouldUseContinuation ? latestSession?.continuationSessionKind || undefined : undefined,
      resumeThreadId:
        shouldUseContinuation && latestSession?.continuationSessionKind === 'codex_thread'
          ? latestSession?.continuationSessionId || undefined
          : undefined,
      continuationMessage: shouldUseContinuation
        ? buildLiveRoomContinuationMessage(liveRoomControlManual, contentForAgent)
        : undefined,
      ephemeralSession: forceEphemeral,
    }],
    workingDirectory: sourceTask.workingDirectory || process.cwd(),
    permissionConfig,
    watchdogConfig,
    streamCallbacks,
  });
};


const executeLiveRoomReplyViaAcpx = async ({
  room,
  sourceMessage,
  targetMember,
  session,
}: {
  room: DeliveryRoom & {
    sourceTask?: {
      id: string;
      name: string;
      description?: string | null;
      workingDirectory?: string | null;
      acpxPermissionConfig?: string | null;
      currentTaskSession?: {
        id: string;
      } | null;
    } | null;
  };
  sourceMessage: {
    id: string;
    content: string;
    senderMember?: {
      id: string;
      displayName: string;
      memberType: string;
    } | null;
  };
  targetMember: DeliveryRoomMember;
  session: {
    id: string;
    threadId: string | null;
  };
}) => {
  const sourceTask = await syncLiveRoomSourceTask(room.id);
  if (!sourceTask) {
    throw new Error('Live room source ACPX task is unavailable');
  }

  const participant = buildLiveRoomAcpxParticipant({
    id: targetMember.id,
    displayName: targetMember.displayName,
    backend: targetMember.backend,
    harnessType: targetMember.harnessType,
    gatewayId: targetMember.backend === 'remote_ssh'
      ? extractRemoteHostIdFromRoleLabel(targetMember.roleLabel) || targetMember.gatewayId
      : targetMember.gatewayId,
    gatewayName: targetMember.gateway?.name || null,
    runtimeAgentId: targetMember.runtimeAgentId || targetMember.agentRecord?.runtimeAgentId || null,
    codexModel: targetMember.codexModel,
    codexReasoningEffort: targetMember.codexReasoningEffort,
  });

  const permissionConfig = resolveLiveRoomMemberPermission(
    targetMember.acpxPermissionConfig,
    sourceTask.acpxPermissionConfig
  );

  const latestSession = await findLatestParticipantSession(sourceTask.id, participant, {
    taskSessionId: sourceTask.currentTaskSession?.id || null,
    permissionConfig,
  });
  const taskRoom = await ensureTaskChatRoom(sourceTask.id, sourceTask.name);
  const shouldInjectLatestInstruction = sourceMessage.senderMember?.memberType !== 'user';

  // 去掉消息开头的 @提及 部分，避免 Claude CLI 误解析为命令
  // 使用贪婪匹配：@xxx yyy -> yyy（支持多词名称）
  const contentForAgent = stripLeadingMentionForTarget({
    content: sourceMessage.content,
    targetDisplayName: targetMember.displayName,
  });
  const desiredDirectedTarget = inferDirectedVisibleRelayTarget({
    room,
    sourceMessage,
    currentTargetMember: targetMember,
  });

  if (shouldInjectLatestInstruction && contentForAgent) {
    await postTaskRoomMessage({
      roomId: taskRoom.id,
      content: contentForAgent,
      userId: 'task-room-user',
      userName: sourceMessage.senderMember?.displayName || '用户',
      targetType: 'participant',
      targetParticipantKey: getTaskRoomParticipantTargetKey(participant),
      targetParticipantLabel: getTaskRoomParticipantTargetLabel(participant),
    });
  }

  await prisma.task.update({
    where: { id: sourceTask.id },
    data: {
      status: 'running',
      startedAt: new Date(),
      completedAt: null,
      error: null,
    },
  });

  await postLiveRoomMessage({
    roomId: room.id,
    content: `系统提示：${targetMember.displayName} 已开始处理这条消息。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      targetMemberId: targetMember.id,
      extras: {
        systemEvent: 'member_reply_started',
      },
    }),
  });

  const feishuBinding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoomId: room.id },
    select: { chatId: true },
  }).catch(() => null);
  console.log(`[delivery] feishuBinding for room ${room.id}: ${feishuBinding ? feishuBinding.chatId : 'null'}`);
  const feishuTracker = feishuBinding ? new FeishuProgressTracker(feishuBinding.chatId) : null;

  let lastProgressPreview = '';
  let lastProgressPostedAt = 0;
  let progressFlushPromise: Promise<void> = Promise.resolve();
  let lastToolSignature = '';
  let lastToolPostedAt = 0;

  const enqueueProgressUpdate = (stream: 'stdout' | 'stderr', chunk: string) => {
    const preview = normalizeProgressPreview(chunk);
    if (!preview) {
      return;
    }

    const now = Date.now();
    if (preview === lastProgressPreview && now - lastProgressPostedAt < LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    if (now - lastProgressPostedAt < LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastProgressPreview = preview;
    lastProgressPostedAt = now;

    progressFlushPromise = progressFlushPromise
      .then(async () => {
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：${targetMember.displayName} 正在处理中${stream === 'stderr' ? '（stderr）' : ''}：${preview}`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            targetMemberId: targetMember.id,
            extras: {
              systemEvent: 'member_reply_progress',
              stream,
              preview,
            },
          }),
        });
      })
      .catch((error) => {
        console.error('Failed to post live room progress update:', error);
      });
  };

  const enqueueToolUpdate = (event: { toolName: string; preview: string; emoji: string }) => {
    const preview = event.preview.trim();
    const signature = `${event.toolName}:${preview}`;
    const now = Date.now();

    if (signature === lastToolSignature && now - lastToolPostedAt < LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastToolSignature = signature;
    lastToolPostedAt = now;

    progressFlushPromise = progressFlushPromise
      .then(async () => {
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：${targetMember.displayName} 正在使用 ${event.toolName}${preview ? `：${preview}` : ''}`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            targetMemberId: targetMember.id,
            extras: {
              systemEvent: 'member_reply_tool',
              toolName: event.toolName,
              toolEmoji: event.emoji,
              preview,
            },
          }),
        });
      })
      .catch((error) => {
        console.error('Failed to post live room tool update:', error);
      });
  };

  const liveRoomStreamCallbacks: HarnessStreamCallbacks = {
    onStdoutChunk: (chunk: string) => {
      enqueueProgressUpdate('stdout', chunk);
    },
    onStderrChunk: (chunk: string) => {
      enqueueProgressUpdate('stderr', chunk);
    },
    onToolEvent: feishuTracker
      ? (event) => {
          feishuTracker.onToolEvent(event.toolName, event.preview, event.emoji);
          enqueueToolUpdate(event);
        }
      : (event) => {
          enqueueToolUpdate(event);
        },
  };

  let acpxResult = await runLiveRoomAcpxAttempt({
    sourceTask,
    room,
    participant,
    contentForAgent,
    desiredDirectedTarget,
    permissionConfig,
    latestSession,
    useFreshSession: false,
    streamCallbacks: liveRoomStreamCallbacks,
  });

  let participantResult = acpxResult.participants[0];
  let finalStatus =
    acpxResult.status === 'completed'
      ? 'completed'
      : acpxResult.status === 'interrupted'
      ? 'running'
      : acpxResult.status === 'stopped'
      ? 'failed'
      : 'failed';

  const firstFailureMessage =
    acpxResult.status === 'failed'
      ? participantResult?.error || 'Live room ACPX execution failed'
      : null;
  const shouldFallback =
    Boolean(firstFailureMessage)
    && shouldRetryWithFreshSession({
      harnessType: targetMember.harnessType,
      message: firstFailureMessage!,
      hasContinuation: Boolean(latestSession?.continuationSessionId),
    });

  if (shouldFallback && latestSession?.participant?.id) {
    const staleReason = firstFailureMessage!;
    await markParticipantContinuationStale({
      participantId: latestSession.participant.id,
      reason: staleReason,
    });
    await markLiveRoomSessionExpired({
      sessionId: session.id,
      reason: `Continuation expired: ${staleReason}`,
    });

    acpxResult = await runLiveRoomAcpxAttempt({
      sourceTask,
      room,
      participant,
      contentForAgent,
      desiredDirectedTarget,
      permissionConfig,
      latestSession,
      useFreshSession: true,
      streamCallbacks: liveRoomStreamCallbacks,
    });
    participantResult = acpxResult.participants[0];
    finalStatus =
      acpxResult.status === 'completed'
        ? 'completed'
        : acpxResult.status === 'interrupted'
        ? 'running'
        : acpxResult.status === 'stopped'
        ? 'failed'
        : 'failed';

    await annotateFreshRetryMetadata({
      taskRunId: acpxResult.taskRunId,
      participantId: participantResult?.participantId,
      staleReason,
      staleParticipantId: latestSession.participant.id,
    });
  }

  if (
    acpxResult.status === 'failed'
    && participantResult?.error
    && shouldRetryCodexEphemeral({
      harnessType: targetMember.harnessType,
      message: participantResult.error,
    })
  ) {
    acpxResult = await runLiveRoomAcpxAttempt({
      sourceTask,
      room,
      participant,
      contentForAgent,
      desiredDirectedTarget,
      permissionConfig,
      latestSession,
      useFreshSession: true,
      forceEphemeral: true,
      streamCallbacks: liveRoomStreamCallbacks,
    });
    participantResult = acpxResult.participants[0];
    finalStatus =
      acpxResult.status === 'completed'
        ? 'completed'
        : acpxResult.status === 'interrupted'
        ? 'running'
        : acpxResult.status === 'stopped'
        ? 'failed'
        : 'failed';

    await annotateFreshRetryMetadata({
      taskRunId: acpxResult.taskRunId,
      participantId: participantResult?.participantId,
      staleReason: 'codex_local_state_error',
      staleParticipantId: latestSession?.participant?.id || null,
    });
  }

  if (feishuTracker) {
    await feishuTracker.flush().catch(() => {});
  }

  await prisma.task.update({
    where: { id: sourceTask.id },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      result: JSON.stringify({
        executionMode: 'acpx',
        source: 'live_room',
        liveRoomId: room.id,
        taskRunId: acpxResult.taskRunId,
        summary: acpxResult.summary,
        participants: acpxResult.participants,
      }),
      error:
        acpxResult.status === 'failed'
          ? participantResult?.error || 'Live room ACPX execution failed'
          : null,
    },
  });

  if (acpxResult.status === 'interrupted') {
    throw new Error('Interrupted by user');
  }

  if (acpxResult.status === 'stopped') {
    throw new Error('Stopped by user');
  }

  if (acpxResult.status === 'failed') {
    await progressFlushPromise.catch(() => undefined);
    throw new Error(participantResult?.error || 'Live room ACPX execution failed');
  }

  await progressFlushPromise.catch(() => undefined);

  const refreshedParticipantSession = await findLatestParticipantSession(sourceTask.id, participant, {
    taskSessionId: sourceTask.currentTaskSession?.id || null,
    permissionConfig,
  });

  return {
    output: participantResult?.summary || acpxResult.summary || `${targetMember.displayName} completed`,
    threadId: refreshedParticipantSession?.continuationSessionId || session.threadId,
    remoteTiming: null,
  };
};

const markRemoteDeliverySuperseded = async (deliveryId: string, reason: string) => {
  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      targetMember: {
        select: {
          id: true,
        },
      },
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!delivery || (delivery.deliveryStatus !== 'pending' && delivery.deliveryStatus !== 'running')) {
    return false;
  }

  await prisma.liveRoomDelivery.update({
    where: { id: deliveryId },
    data: {
      deliveryStatus: 'superseded',
      fallbackReason: reason,
      acknowledgedAt: new Date(),
    },
  });

  if (delivery.sessionId) {
    await prisma.liveRoomMemberSession.update({
      where: { id: delivery.sessionId },
      data: {
        status: 'online',
        lastError: reason,
      },
    }).catch(() => undefined);
  }

  await prisma.liveRoomMember.update({
    where: { id: delivery.targetMemberId },
    data: {
      presenceStatus: 'online',
    },
  }).catch(() => undefined);

  return true;
};

const failStaleRemoteDeliveries = async (memberId: string) => {
  const staleBefore = new Date(Date.now() - REMOTE_STALE_AFTER_MS);
  const registryEntry = getLiveRoomRunningProcess(memberId);

  if (registryEntry && Date.now() - registryEntry.startedAt >= REMOTE_STALE_AFTER_MS) {
    interruptLiveRoomRunningProcess(memberId, 'SIGTERM');
  }

  const staleDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: memberId,
      deliveryStatus: {
        in: ['pending', 'running'],
      },
      attemptedAt: {
        lt: staleBefore,
      },
    },
    include: {
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  for (const delivery of staleDeliveries) {
    if (registryEntry?.deliveryId === delivery.id) {
      continue;
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Remote SSH live room delivery became stale before completion',
        acknowledgedAt: new Date(),
      },
    });

    if (delivery.sessionId) {
      await prisma.liveRoomMemberSession.update({
        where: { id: delivery.sessionId },
        data: {
          status: 'online',
          lastError: 'Remote SSH live room delivery became stale before completion',
        },
      }).catch(() => undefined);
    }
  }

  if (staleDeliveries.length > 0) {
    await prisma.liveRoomMember.update({
      where: { id: memberId },
      data: {
        presenceStatus: 'online',
      },
    }).catch(() => undefined);
  }
};

const processLiveRoomDelivery = async ({
  deliveryId,
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth,
  allowChainedMentions,
}: {
  deliveryId: string;
  roomId: string;
  roomMessageId: string;
  targetMemberId: string;
  chainDepth: number;
  allowChainedMentions: boolean;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      sourceTask: true,
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
    include: {
      senderMember: true,
    },
  });

  if (!sourceMessage) {
    return;
  }

  const targetMember = room.members.find((member) => member.id === targetMemberId);
  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery || delivery.deliveryStatus !== 'pending') {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);

  if (targetMember.backend === 'remote_ssh') {
    await failStaleRemoteDeliveries(targetMember.id);

    const newerPendingDelivery = await prisma.liveRoomDelivery.findFirst({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        createdAt: {
          gt: delivery.createdAt,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
      },
    });

    if (newerPendingDelivery) {
      await markRemoteDeliverySuperseded(
        delivery.id,
        `Superseded by newer live room delivery ${newerPendingDelivery.id}`
      );
      return;
    }
  }

  await prisma.liveRoomDelivery.update({
    where: { id: delivery.id },
    data: {
      sessionId: session.id,
      deliveryStatus: 'running',
      attemptedAt: new Date(),
      fallbackReason: null,
    },
  });

  await prisma.liveRoomMember.update({
    where: { id: targetMember.id },
    data: {
      presenceStatus: 'busy',
    },
  });

  try {
    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'busy',
        lastHeartbeatAt: new Date(),
        lastError: 'progress:acpx participant running',
      },
    }).catch(() => undefined);

    const acpxResult = await executeLiveRoomReplyViaAcpx({
      room,
      sourceMessage: {
        id: sourceMessage.id,
        content: sourceMessage.content,
        senderMember: sourceMessage.senderMember
          ? {
              id: sourceMessage.senderMember.id,
              displayName: sourceMessage.senderMember.displayName,
              memberType: sourceMessage.senderMember.memberType,
            }
          : null,
      },
      targetMember,
      session: {
        id: session.id,
        threadId: session.threadId,
      },
    });

    let output = acpxResult.output;
    const threadId = acpxResult.threadId;
    const remoteTiming = acpxResult.remoteTiming;

    if (threadId !== session.threadId || session.status !== 'online') {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          threadId,
          status: 'online',
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    } else {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'delivered',
        acknowledgedAt: new Date(),
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'online',
      },
    });

    try {
      const roomControl = parseLiveRoomControlAction(output);
      if (roomControl) {
        await executeLiveRoomControlAction({
          roomId: room.id,
          actorDisplayName: targetMember.displayName,
          action: roomControl.action,
        });
        output = roomControl.remainingOutput;
      }
    } catch (roomControlError) {
      await postLiveRoomMessage({
        roomId: room.id,
        content: `系统提示：${targetMember.displayName} 的 room-control 动作执行失败：${roomControlError instanceof Error ? roomControlError.message : 'unknown error'}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          extras: {
            systemEvent: 'room_control_failed',
            actorDisplayName: targetMember.displayName,
          },
        }),
      });
      output = output.replace(LIVE_ROOM_CONTROL_BLOCK_PATTERN, '').trim();
    }

    let replyMessage: Awaited<ReturnType<typeof postLiveRoomMessage>> | null = null;
    if (output) {
      const mentionDetection = detectMentionedLiveRoomMembers({
        content: output,
        members: room.members,
        senderMemberId: targetMember.id,
      });
      const startsWithExplicitMention = /^[\s]*[@$][^\s]+/.test(output);
      const isDirectedVisibleReply =
        startsWithExplicitMention
        && mentionDetection.matchType === 'explicit'
        && mentionDetection.memberIds.length === 1
        && !detectLiveRoomMentionAll(output);
      const directedTargetMemberId = isDirectedVisibleReply ? mentionDetection.memberIds[0] : null;
      const directedTargetMember = directedTargetMemberId
        ? room.members.find((member) => member.id === directedTargetMemberId) || null
        : null;

      replyMessage = await postLiveRoomMessage({
        roomId: room.id,
        senderMemberId: targetMember.id,
        content: output,
        messageType: 'assistant',
        visibility: isDirectedVisibleReply ? 'directed_visible' : 'room',
        replyToMessageId: sourceMessage.id,
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'assistant',
          targetMemberId: directedTargetMemberId,
          visibilityMode: isDirectedVisibleReply ? 'directed_visible' : 'room',
          replyToMessageId: sourceMessage.id,
          mentionedMemberIds: mentionDetection.memberIds,
          mentionedAll: detectLiveRoomMentionAll(output),
          expectedResponderMemberIds: detectLiveRoomMentionAll(output)
            ? room.members.filter((member) => member.canReply && member.id !== targetMember.id).map((member) => member.id)
            : [],
          extras: {
            deliveryId: delivery.id,
            backend: targetMember.backend,
            harnessType: targetMember.harnessType,
            chainDepth,
            remoteTiming,
            targetLocked: isDirectedVisibleReply,
            targetMemberName: directedTargetMember?.displayName || null,
          },
        }),
      });
    }

    if (replyMessage && allowChainedMentions && chainDepth < 2) {
      const replyMetadata = parseLiveRoomMessageMetadata(JSON.stringify(replyMessage.metadata || null));

      // 只有明确的 handoff 或 ask 模式才会触发连锁回复
      // agent 消息中的普通 @提及 (broadcast) 不会触发
      const shouldChain = replyMetadata?.deliveryIntent === 'handoff' ||
                         replyMetadata?.deliveryIntent === 'directed_visible' ||
                         replyMetadata?.deliveryIntent === 'ask' ||
                         replyMetadata?.mentionedAll;

      if (shouldChain) {
        const nextTargetMemberIds = getTargetMemberIdsForMessage({
          room,
          sourceMessageSenderMemberId: targetMember.id,
          sourceMetadata: replyMetadata,
          requestedTargetMemberId: null,
          sourceContent: replyMessage.content,
        });

        for (const nextTargetMemberId of nextTargetMemberIds) {
          await triggerLiveRoomAgentReply({
            roomId: room.id,
            roomMessageId: replyMessage.id,
            targetMemberId: nextTargetMemberId,
            chainDepth: chainDepth + 1,
            allowChainedMentions: !(replyMetadata?.deliveryIntent === 'mention_all' || replyMetadata?.mentionedAll),
          });
        }
      }
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Live room delivery failed';
    const message = normalizeLiveRoomExecutionError(rawMessage);

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: message,
        acknowledgedAt: new Date(),
      },
    });

    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'online',
        lastError: message,
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'idle',
      },
    });

    if (message !== 'Interrupted by user') {
      await postLiveRoomMessage({
        roomId,
        content:
          message === 'Stopped by user'
            ? `系统提示：${targetMember.displayName} 当前回复已被停止。`
            : `系统提示：${targetMember.displayName} 本次回复失败：${message}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          targetMemberId: targetMember.id,
          extras: {
            error: message,
          },
        }),
      });
    }
  } finally {
    if (targetMember.backend === 'remote_ssh') {
      clearLiveRoomRunningProcess(targetMember.id, delivery.id);
    }
  }
};

export const interruptLiveRoomMemberReplies = async ({
  roomId,
  memberId,
}: {
  roomId: string;
  memberId: string;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });

  if (!room) {
    throw new Error('Live room not found');
  }

  const member = await prisma.liveRoomMember.findFirst({
    where: {
      id: memberId,
      roomId,
    },
    select: {
      id: true,
      displayName: true,
      backend: true,
      canReply: true,
    },
  });

  if (!member) {
    throw new Error('Live room member not found');
  }

  if (!member.canReply) {
    throw new Error('Selected member cannot reply');
  }

  if (member.backend !== 'remote_ssh') {
    throw new Error('Only remote SSH live room replies can be interrupted in Phase 1');
  }

  const runningDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'running',
    },
    orderBy: {
      attemptedAt: 'desc',
    },
  });

  const queuedDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'pending',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const activeRun = room.sourceTask?.currentTaskSession?.activeRunId
    ? await prisma.taskRun.findUnique({
        where: { id: room.sourceTask.currentTaskSession.activeRunId },
        include: {
          participants: true,
        },
      })
    : null;
  const runningParticipant = activeRun?.participants.find((participant) => {
    const metadata = parseAcpxMetadata(participant.controlMetadata);
    return metadata.continuationKey === getLiveRoomParticipantContinuationKey(member.id);
  }) || null;

  if (activeRun && runningParticipant) {
    requestRunControl(activeRun.id, runningParticipant.id, 'interrupt_now');
  } else {
    const runningRegistry = getLiveRoomRunningProcess(member.id);
    if (runningRegistry) {
      interruptLiveRoomRunningProcess(member.id, 'SIGTERM');
    }
  }

  const interruptedAt = new Date();

  if (runningDeliveries.length > 0) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: runningDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Interrupted by user',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  if (queuedDeliveries.length > 0) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: queuedDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: 'Cancelled by user before execution',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  const latestSession = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (latestSession) {
    await prisma.liveRoomMemberSession.update({
      where: { id: latestSession.id },
      data: {
        status: 'online',
        lastError: runningDeliveries.length > 0 ? 'Interrupted by user' : 'Cancelled by user before execution',
      },
    });
  }

  await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: {
      presenceStatus: 'online',
    },
  });

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：已中断 ${member.displayName} 的远端回复${queuedDeliveries.length > 0 ? `，并清理 ${queuedDeliveries.length} 条排队消息` : ''}。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      targetMemberId: member.id,
      extras: {
        systemEvent: 'remote_reply_interrupted',
        interruptedDeliveryIds: runningDeliveries.map((delivery) => delivery.id),
        supersededDeliveryIds: queuedDeliveries.map((delivery) => delivery.id),
      },
    }),
  });

  return {
    interruptedRunningCount: runningDeliveries.length,
    cancelledQueuedCount: queuedDeliveries.length,
  };
};

export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
  allowChainedMentions = true,
  forceTargetMember = false,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
  allowChainedMentions?: boolean;
  forceTargetMember?: boolean;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      sourceTask: true,
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
    include: {
      senderMember: true,
    },
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const targetMember = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId: targetMemberId,
    preferRequestedTarget: forceTargetMember,
  });

  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);
  const delivery = await prisma.liveRoomDelivery.create({
    data: {
      roomMessageId,
      targetMemberId: targetMember.id,
      sessionId: session.id,
      deliveryStatus: 'pending',
    },
  });

  if (targetMember.backend === 'remote_ssh') {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        id: {
          not: delivery.id,
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: `Superseded by newer live room delivery ${delivery.id}`,
        acknowledgedAt: new Date(),
      },
    });

    await enqueueLiveRoomMemberExecution(targetMember.id, async () => {
      await processLiveRoomDelivery({
        deliveryId: delivery.id,
        roomId: room.id,
        roomMessageId,
        targetMemberId: targetMember.id,
        chainDepth,
        allowChainedMentions,
      });
    });
    return;
  }

  await processLiveRoomDelivery({
    deliveryId: delivery.id,
    roomId: room.id,
    roomMessageId,
    targetMemberId: targetMember.id,
    chainDepth,
    allowChainedMentions,
  });
};

export const triggerLiveRoomMessageReplies = async ({
  roomId,
  roomMessageId,
  requestedTargetMemberId,
}: {
  roomId: string;
  roomMessageId: string;
  requestedTargetMemberId?: string | null;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const targetMemberIds = getTargetMemberIdsForMessage({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
    sourceContent: sourceMessage.content,
  });

  if (targetMemberIds.length === 0) {
    return;
  }

  const isMentionAll = sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll;
  const isRoleQueue =
    !isMentionAll
    && targetMemberIds.length > 1
    && shouldRunRoleQueue(room.mode, sourceMessage.content);
  if (isMentionAll) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：$all 已发送，当前共有 ${targetMemberIds.length} 个可回复成员会按顺序回应。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        mentionedAll: true,
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: {
          systemEvent: 'mention_all_dispatch_started',
        },
      }),
    });
  } else if (isRoleQueue) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：${room.mode} role queue 已启动：${targetMemberIds
        .map((memberId) => room.members.find((member) => member.id === memberId)?.displayName)
        .filter(Boolean)
        .join(' → ')}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: { systemEvent: 'role_queue_started' },
      }),
    });
  }

  const allowChainedMentions = !isMentionAll && !isRoleQueue;
  for (let index = 0; index < targetMemberIds.length; index += 1) {
    const targetMemberId = targetMemberIds[index];
    if (index > 0 && isMentionAll) {
      await sleep(ALL_REPLY_STAGGER_MS);
    }

    await triggerLiveRoomAgentReply({
      roomId,
      roomMessageId,
      targetMemberId,
      chainDepth: 0,
      allowChainedMentions,
      forceTargetMember: isMentionAll,
    });
  }
};
