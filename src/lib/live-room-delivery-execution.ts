import { taskGraphAgentReviewPermissionConfig } from './task-graph/review-permissions';
import { prepareGraphConversationTask } from './task-graph/conversation-task';
import { collectLiveRoomFootnotes } from '@/lib/live-room-footnotes';
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
import { resolveLiveRoomExecutionWatchdogConfig } from '@/lib/live-room-execution-timeout';
import { getLiveRoomExecutionGeneration, registerLiveRoomSteering } from '@/lib/live-room-process-registry';
import {
  getPreferredDirectedAlias,
  inferDirectedVisibleRelayTargets,
  type DeliveryRoom,
  type DeliveryRoomMember,
} from '@/lib/live-room-delivery-routing';
import {
  attachLiveRoomProgress,
  isUsefulLiveRoomThinkingPreview,
  shouldRelayLiveRoomStdoutProgress,
} from '@/lib/live-room-progress';

export { isUsefulLiveRoomThinkingPreview, shouldRelayLiveRoomStdoutProgress };

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

  // Only explicit session/thread invalid signals may open a fresh session.
  // Wall-clock execution timeouts ("timed out after ...ms") must simply fail the
  // current run; they never invalidate the continuation session.
  return isInvalidContinuationError(harnessType, message);
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
  const discussion = sourceTask.id.startsWith('task-graph-discussion-');
  const shouldUseContinuation =
    !discussion
    &&
    !useFreshSession
    && !forceEphemeral
    && Boolean(latestSession?.continuationSessionId);

  // Explicit room timeout overrides every backend (remote SSH and remote runner share
  // this single resolution). Without one, keep the runner-harness defaults: Platform
  // Local codex/claude/kimi-code unlimited, remote backends 10 minutes.
  const watchdogConfig = resolveLiveRoomExecutionWatchdogConfig({
    executionTimeoutMs: room.executionTimeoutMs,
    executionBackend: participant.executionBackend,
    harnessType: participant.harnessType,
  });

  const replyableMembers = room.members
    .filter((member) => member.canReply && member.id !== currentMemberId)
    .map((member) => ({ label: member.displayName, token: `$${getPreferredDirectedAlias(member)}` }));
  const directedTargetAlias = desiredDirectedTarget ? getPreferredDirectedAlias(desiredDirectedTarget) : null;
  const liveRoomControlManual = buildLiveRoomControlManual({
    replyableMemberLabels: replyableMembers.map((member) => member.label),
    replyableMemberTokens: replyableMembers.map((member) => member.token),
    directedTargetAlias,
    directedTargetDisplayName: desiredDirectedTarget?.displayName || null,
  }) + (sourceTask.description?.includes('<graph-control>')
    ? '\n任务图：用户明确说继续、接着或往下走时，输出 <graph-control>{"action":"resume_task","nodeKey":"当前实际 Slice 键"}</graph-control>，平台会核验原用户权限并接续。只问状态、仅发图片、否定继续时不得输出。不要要求搬图或再发 resume。'
    : '');
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
        ? buildLiveRoomContinuationMessage(directedVisibleProtocol, contentForAgent)
        : undefined,
      ephemeralSession: forceEphemeral || discussion,
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
  const startedAt = Date.now();
  const executionGeneration = getLiveRoomExecutionGeneration(targetMember.id);
  const originalSourceTask = await syncLiveRoomSourceTask(room.id);
  const sourceTask = originalSourceTask ? await prepareGraphConversationTask(originalSourceTask) : null;
  if (!sourceTask) {
    throw new Error('Live room source ACPX task is unavailable');
  }
  const workflowCompletionGate = parseLiveRoomMessageMetadata(sourceMessage.metadata)?.source === 'workflow_watcher';
  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const relayOrigin = {
    feishuBindingId: sourceMetadata?.feishuBindingId,
    feishuChatId: sourceMetadata?.feishuChatId,
  };

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
  const progress = await attachLiveRoomProgress({ room, participant: targetMember, sourceMessage });
  const streamCallbacks: HarnessStreamCallbacks = {
    ...progress.streamCallbacks,
    onSteeringReady: targetMember.backend === 'platform_local' && ['pi-agent', 'codex', 'antigravity'].includes(targetMember.harnessType || '')
      && !workflowCompletionGate
      ? (steer) => registerLiveRoomSteering(targetMember.id, room.id, session.id, steer, executionGeneration, sourceMessage.id)
      : undefined,
  };
  let progressDisposed = false;
  const disposeProgress = async (summary: string, success: boolean) => {
    if (progressDisposed) return;
    progressDisposed = true;
    await progress.dispose(summary, success);
  };

  const workflowPermissionSnapshot = readWorkflowPermissionSnapshot(
    sourceMetadata?.workflowPermissionSnapshot,
    sourceTask.workingDirectory || process.cwd(),
  );
  const permissionConfig = sourceTask.id !== originalSourceTask?.id ? taskGraphAgentReviewPermissionConfig : applyWorkflowPermissionSnapshot(
    resolveLiveRoomMemberPermission(targetMember.acpxPermissionConfig, sourceTask.acpxPermissionConfig),
    workflowPermissionSnapshot,
  );

  const latestSession = await findLatestParticipantSession(sourceTask.id, participant, {
    taskSessionId: sourceTask.currentTaskSession?.id || null,
    permissionConfig,
    allowRoleFallback: true,
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

  if ((shouldInjectLatestInstruction || sourceTask.id !== originalSourceTask?.id) && contentForAgent) {
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
        ...(progress.progressTracker ? { skipFeishuRelay: true } : {}),
      },
    }),
  });

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
    streamCallbacks,
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
    progress.progressTracker?.onSystemEvent(`续聊会话失效，自动开启新会话重试: ${staleReason}`, '⚠️');
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
      streamCallbacks,
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
    progress.progressTracker?.onSystemEvent('Codex 状态异常，自动使用临时会话重试', '⚠️');
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
      streamCallbacks,
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

  const finalSummary = acpxResult.status === 'completed'
    ? participantResult?.summary || acpxResult.summary || `${targetMember.displayName} 执行完成`
    : participantResult?.error || acpxResult.summary || `${targetMember.displayName} 执行失败`;
  const footnotes = await collectLiveRoomFootnotes({
    participantId: participantResult?.participantId, startedAt,
    model: participant.model, reasoningEffort: participant.reasoningEffort,
  });
  progress.progressTracker?.setFootnotes(footnotes);
  await disposeProgress(finalSummary.replace(/<graph-control>[\s\S]*?<\/graph-control>/g, '').trim(), acpxResult.status === 'completed');

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
    footnotes,
  };
  } finally {
    await disposeProgress(`${targetMember.displayName} 执行失败`, false);
  }
};
