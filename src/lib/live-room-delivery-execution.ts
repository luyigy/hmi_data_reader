import { prisma } from '@/lib/prisma';
import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { findLatestParticipantSession } from '@/lib/acpx/session-tracking';
import { getHarnessAdapter } from '@/lib/harness';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import {
  buildLiveRoomAcpxParticipant,
  extractRemoteHostIdFromRoleLabel,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import {
  getTaskRoomParticipantTargetKey,
  getTaskRoomParticipantTargetLabel,
} from '@/lib/task-room-targets';
import type { AcpxPermissionConfig, HarnessStreamCallbacks } from '@/lib/acpx/types';
import {
  buildLiveRoomContinuationMessage,
  buildLiveRoomControlManual,
  stripLeadingMentionForTarget,
} from '@/lib/live-room-protocol';
import {
  applyWorkflowPermissionSnapshot,
  readWorkflowPermissionSnapshot,
} from '@/lib/workflow-execution-policy';
import {
  getPreferredDirectedAlias,
  inferDirectedVisibleRelayTargets,
  type DeliveryRoom,
  type DeliveryRoomMember,
} from '@/lib/live-room-delivery-routing';
import { FeishuProgressTracker } from '@/lib/feishu-progress';

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

export const normalizeLiveRoomExecutionError = (message: string) => {
  // Strip embedded null bytes (from WSL UTF-16LE startup messages decoded as UTF-8)
  let normalized = message.replace(/\0/g, '');

  for (const pattern of SSH_WARNING_PATTERNS) {
    normalized = normalized.replace(pattern, '').trim();
  }

  return normalized.trim() || 'Live room execution failed';
};

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

// Local Codex receives the task-room transcript, so avoid reusing CLI threads that
// may retain incomplete tool calls after an interruption.
const shouldPreferTranscriptContinuation = (participant: ReturnType<typeof buildLiveRoomAcpxParticipant>) =>
  participant.executionBackend === 'platform_local' && participant.harnessType === 'codex';

const LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS = 8000;
const LIVE_ROOM_TOOL_MIN_INTERVAL_MS = 3000;
const LIVE_ROOM_HEARTBEAT_INTERVAL_MS = 45_000;

export const shouldRelayLiveRoomStdoutProgress = (harnessType: string | null) =>
  harnessType === 'codex' || harnessType === 'kimi-code';

export const isUsefulLiveRoomThinkingPreview = (text: string) =>
  text.length >= 80 || /[.!?。！？]\s*$/.test(text);

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
  currentMemberId,
  contentForAgent,
  desiredDirectedTarget,
  permissionConfig,
  latestSession,
  useFreshSession,
  forceEphemeral = false, workflowCompletionGate,
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
  currentMemberId: string;
  contentForAgent: string;
  desiredDirectedTarget?: DeliveryRoomMember | null;
  permissionConfig: AcpxPermissionConfig;
  latestSession: Awaited<ReturnType<typeof findLatestParticipantSession>>;
  useFreshSession: boolean;
  forceEphemeral?: boolean; workflowCompletionGate: boolean;
  streamCallbacks?: HarnessStreamCallbacks;
}) => {
  const shouldUseContinuation =
    !useFreshSession
    && !forceEphemeral
    && !shouldPreferTranscriptContinuation(participant)
    && Boolean(latestSession?.continuationSessionId);

  const watchdogConfig =
    participant.executionBackend === 'platform_local'
      && ['codex', 'claude', 'kimi-code'].includes(participant.harnessType)
      ? { maxRuntimeMs: null }
      : undefined;

  const replyableMembers = room.members
    .filter((member) => member.canReply && member.id !== currentMemberId)
    .map((member) => ({ label: member.displayName, token: `$${getPreferredDirectedAlias(member)}` }));
  const directedTargetAlias = desiredDirectedTarget ? getPreferredDirectedAlias(desiredDirectedTarget) : null;
  const liveRoomControlManual = buildLiveRoomControlManual({
    replyableMemberLabels: replyableMembers.map((member) => member.label),
    replyableMemberTokens: replyableMembers.map((member) => member.token),
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
    workflowCompletionGate, orchestrationMode: 'single',
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
      codexHome:
        participant.executionBackend === 'platform_local' && participant.harnessType === 'codex'
          ? `/data1/.agent-platform/codex-rooms/${room.id}`
          : undefined,
    }],
    workingDirectory: sourceTask.workingDirectory || process.cwd(),
    permissionConfig,
    watchdogConfig,
    streamCallbacks,
  });
};

export const executeLiveRoomReplyViaAcpx = async ({
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
    content: string; metadata?: string | null;
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
  const workflowCompletionGate = parseLiveRoomMessageMetadata(sourceMessage.metadata)?.source === 'workflow_watcher';
  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const relayOrigin = {
    feishuBindingId: sourceMetadata?.feishuBindingId,
    feishuChatId: sourceMetadata?.feishuChatId,
  };

  // Resolve Feishu chatId for interactive progress card (prefer metadata, fallback to DB)
  const bindingRows = await prisma.$queryRaw<Array<{ chatId: string }>>`
    SELECT "chatId" FROM "FeishuConversationBinding"
    WHERE "liveRoomId" = ${room.id}
    LIMIT 1
  `;
  const metadataChatId = typeof relayOrigin.feishuChatId === 'string' ? relayOrigin.feishuChatId : null;
  const feishuChatId: string | null = metadataChatId || bindingRows[0]?.chatId || null;

  const progressTracker = feishuChatId
    ? new FeishuProgressTracker(feishuChatId)
    : null;

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

  const workflowPermissionSnapshot = readWorkflowPermissionSnapshot(
    sourceMetadata?.workflowPermissionSnapshot,
    sourceTask.workingDirectory || process.cwd(),
  );
  const permissionConfig = applyWorkflowPermissionSnapshot(
    resolveLiveRoomMemberPermission(targetMember.acpxPermissionConfig, sourceTask.acpxPermissionConfig),
    workflowPermissionSnapshot,
  );

  const latestSession = await findLatestParticipantSession(sourceTask.id, participant, {
    taskSessionId: sourceTask.currentTaskSession?.id || null,
    permissionConfig,
  });
  const taskRoom = await ensureTaskChatRoom(sourceTask.id, sourceTask.name);
  const shouldInjectLatestInstruction = sourceMessage.senderMember?.memberType !== 'user';

  const contentForAgent = stripLeadingMentionForTarget({
    content: sourceMessage.content,
    targetDisplayName: targetMember.displayName,
  });
  const directedRelayTargets = inferDirectedVisibleRelayTargets({
    room,
    sourceMessage,
    currentTargetMember: targetMember,
  });
  const desiredDirectedTarget = directedRelayTargets[0] || null;

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
        ...relayOrigin,
        systemEvent: 'member_reply_started',
        ...(progressTracker ? { skipFeishuRelay: true } : {}),
      },
    }),
  });

  progressTracker?.onSystemEvent(`开始处理消息 | ${targetMember.displayName} (${targetMember.harnessType})`, '🚀');

  let progressFlushPromise: Promise<void> = Promise.resolve();
  let lastToolSignature = '';
  let lastToolPostedAt = 0;
  let lastVisibleActivityAt = Date.now();

  const enqueueHeartbeatUpdate = () => {
    lastVisibleActivityAt = Date.now();
    progressTracker?.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');
    progressFlushPromise = progressFlushPromise
      .then(async () => {
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：${targetMember.displayName} 仍在处理中，当前步骤耗时较长。`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            targetMemberId: targetMember.id,
            extras: {
              ...relayOrigin,
              systemEvent: 'member_reply_progress',
              harnessType: targetMember.harnessType,
              progressKind: 'heartbeat',
              preview: '当前步骤耗时较长',
              ...(progressTracker ? { skipFeishuRelay: true } : {}),
            },
          }),
        });
      })
      .catch((error) => {
        console.error('Failed to post live room progress update:', error);
      });
  };

  let lastThinkingPostedAt = 0;
  let lastThinkingPreview = '';
  let pendingThinkingText = '';

  const enqueueThinkingUpdate = (chunk: string) => {
    const isCodex = targetMember.harnessType === 'codex';
    const text = isCodex
      ? (pendingThinkingText += chunk).trim()
      : chunk.trim();
    const preview = text.slice(0, 80);
    if (!preview) return;
    if (isCodex && !isUsefulLiveRoomThinkingPreview(text)) return;
    const now = Date.now();
    if (now - lastThinkingPostedAt < LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    if (preview === lastThinkingPreview) {
      pendingThinkingText = '';
      return;
    }
    lastThinkingPreview = preview;
    lastThinkingPostedAt = now;
    lastVisibleActivityAt = now;
    pendingThinkingText = '';

    progressTracker?.onSystemEvent(`思考分析：${preview}`, '🧠');

    progressFlushPromise = progressFlushPromise
      .then(async () => {
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：${targetMember.displayName} 正在分析：${preview}${text.length > 80 ? '…' : ''}`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            targetMemberId: targetMember.id,
            extras: {
              ...relayOrigin,
              systemEvent: 'member_reply_thinking',
              harnessType: targetMember.harnessType,
              preview,
              ...(progressTracker ? { skipFeishuRelay: true } : {}),
            },
          }),
        });
      })
      .catch((error) => {
        console.error('Failed to post live room thinking update:', error);
      });
  };

  const enqueueToolUpdate = (event: { toolName: string; preview: string; emoji: string }, skipFeishuRelay = false) => {
    const preview = event.preview.trim();
    const signature = `${event.toolName}:${preview}`;
    const now = Date.now();
    if (now - lastToolPostedAt < LIVE_ROOM_TOOL_MIN_INTERVAL_MS) {
      return;
    }
    if (signature === lastToolSignature) {
      return;
    }

    lastToolSignature = signature;
    lastToolPostedAt = now;
    lastVisibleActivityAt = now;

    const extras: Record<string, unknown> = {
      ...relayOrigin,
      systemEvent: 'member_reply_tool',
      harnessType: targetMember.harnessType,
      toolName: event.toolName,
      toolEmoji: event.emoji,
      preview,
    };
    if (skipFeishuRelay) {
      extras.skipFeishuRelay = true;
    }

    progressFlushPromise = progressFlushPromise
      .then(async () => {
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：${targetMember.displayName} 正在使用 ${event.toolName}${preview ? `：${preview}` : ''}`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            targetMemberId: targetMember.id,
            extras,
          }),
        });
      })
      .catch((error) => {
        console.error('Failed to post live room tool update:', error);
      });
  };

  const liveRoomStreamCallbacks: HarnessStreamCallbacks = {
    ...(shouldRelayLiveRoomStdoutProgress(targetMember.harnessType) ? {
      onStdoutChunk: (chunk: string) => { enqueueThinkingUpdate(chunk); },
    } : {}),
    onToolEvent: (event) => {
      if (progressTracker) {
        // Interactive progress card handles tool events for Feishu
        progressTracker.onToolEvent(event.toolName, event.preview, event.emoji);
      }
      // Always post to live room web UI (skip Feishu relay when tracker is active)
      enqueueToolUpdate(event, progressTracker ? true : false);
    },
  };

  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastVisibleActivityAt >= LIVE_ROOM_HEARTBEAT_INTERVAL_MS) {
      enqueueHeartbeatUpdate();
    }
  }, LIVE_ROOM_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  try {

  let acpxResult = await runLiveRoomAcpxAttempt({
    sourceTask,
    room,
    participant,
    currentMemberId: targetMember.id,
    contentForAgent,
    desiredDirectedTarget,
    permissionConfig,
    latestSession,
    useFreshSession: false, workflowCompletionGate,
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
    progressTracker?.onSystemEvent(`续聊会话失效，自动开启新会话重试: ${staleReason}`, '⚠️');
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
      currentMemberId: targetMember.id,
      contentForAgent,
      desiredDirectedTarget,
      permissionConfig,
      latestSession,
      useFreshSession: true, workflowCompletionGate,
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
    progressTracker?.onSystemEvent('Codex 状态异常，自动使用临时会话重试', '⚠️');
    acpxResult = await runLiveRoomAcpxAttempt({
      sourceTask,
      room,
      participant,
      currentMemberId: targetMember.id,
      contentForAgent,
      desiredDirectedTarget,
      permissionConfig,
      latestSession,
      useFreshSession: true,
      forceEphemeral: true, workflowCompletionGate,
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

  clearInterval(heartbeatTimer);
  await progressFlushPromise.catch(() => undefined);

  // Finalize Feishu interactive progress card
  if (progressTracker) {
    const finalSummary = acpxResult.status === 'completed'
      ? participantResult?.summary || acpxResult.summary || `${targetMember.displayName} 执行完成`
      : participantResult?.error || acpxResult.summary || `${targetMember.displayName} 执行失败`;
    await progressTracker.finalize(finalSummary, acpxResult.status === 'completed').catch(() => {});
  }

  if (acpxResult.status === 'interrupted') {
    throw new Error('Interrupted by user');
  }

  if (acpxResult.status === 'stopped') {
    throw new Error('Stopped by user');
  }

  if (acpxResult.status === 'failed') {
    throw new Error(participantResult?.error || 'Live room ACPX execution failed');
  }

  const refreshedParticipantSession = await findLatestParticipantSession(sourceTask.id, participant, {
    taskSessionId: sourceTask.currentTaskSession?.id || null,
    permissionConfig,
  });

  return {
    output: participantResult?.summary || acpxResult.summary || `${targetMember.displayName} completed`,
    threadId: refreshedParticipantSession?.continuationSessionId || session.threadId,
    remoteTiming: null,
  };
  } finally {
    clearInterval(heartbeatTimer);
  }
};
