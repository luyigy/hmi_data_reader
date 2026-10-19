import { prisma } from '@/lib/prisma';
import { executeAcpxTaskRunWithContinuationFallback } from './continuation-retry';
import { publishTaskRunEvent } from './event-bus';
import { getContinuationSession } from './session-tracking';
import {
  DEFAULT_ACPX_PERMISSION_CONFIG,
  normalizeAcpxPermissionConfig,
} from './permissions';
import { resolveTaskSessionPermissionConfig } from './session';
import type { AcpxPermissionConfig, TaskRunInteractionRequestStatus } from './types';
import { cancelInProcessApproval, resolveInProcessApproval } from './in-process-approvals';
import { getRunningProcess } from './process-registry';
import { receiveGraphTaskMessage } from '../task-graph/conversation-inbox';

const parseMetadata = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const stringifyMetadata = (value: Record<string, unknown>) => JSON.stringify(value);

const readTaskPermissionConfig = (value: string | null | undefined) => {
  try {
    return normalizeAcpxPermissionConfig(
      JSON.parse(value || 'null') as AcpxPermissionConfig | null
    );
  } catch {
    return DEFAULT_ACPX_PERMISSION_CONFIG;
  }
};

const toParticipantEventPayload = (participant: {
  gatewayId?: string | null;
  gatewayNameSnapshot: string;
  executionBackend: string;
  harnessType: string;
  harnessNameSnapshot?: string | null;
  role: string;
  agentId?: string | null;
  agentNameSnapshot?: string | null;
}) => ({
  gatewayId: participant.gatewayId,
  gatewayName: participant.gatewayNameSnapshot,
  executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
  harnessType: participant.harnessType,
  harnessLabel: participant.harnessNameSnapshot,
  role: participant.role,
  agentId: participant.agentId,
  agentName: participant.agentNameSnapshot,
});

const buildContinuationMessage = (args: {
  requestKind: string;
  action: 'approve' | 'deny' | 'answer';
  responseText?: string | null;
}) => {
  if (args.action === 'deny') {
    return null;
  }

  if (args.requestKind === 'permission_request') {
    return args.responseText?.trim()
      ? `The user approved your previous permission request. Additional instruction: ${args.responseText.trim()}`
      : 'The user approved your previous permission request. Continue the task.';
  }

  if (args.requestKind === 'choice_request' || args.requestKind === 'input_request') {
    return args.responseText?.trim()
      ? `The user responded to your previous request:\n${args.responseText.trim()}`
      : 'The user answered your previous request. Continue the task with that answer.';
  }

  return args.responseText?.trim() || 'The user reviewed your previous request. Continue the task.';
};

export const resolveInteractionRequestWithContinuation = async (args: {
  requestId: string;
  action: 'approve' | 'deny' | 'answer';
  responseText?: string | null;
  actor: {
    id: string;
    name: string;
    channel: 'feishu' | 'web' | 'terminal';
  };
}) => {
  const request = await prisma.taskRunInteractionRequest.findUnique({
    where: { id: args.requestId },
    include: {
      task: true,
      taskRun: {
        include: {
          participants: true,
        },
      },
      participant: true,
      taskSession: true,
    },
  });

  if (!request) {
    throw new Error('Interaction request not found');
  }

  if (request.status !== 'pending') {
    throw new Error(`Interaction request is already ${request.status}`);
  }
  if (request.expiresAt && request.expiresAt <= new Date()) throw new Error('Interaction request is expired');
  if (args.action === 'answer' && ['input_request', 'choice_request'].includes(request.requestKind) &&
    await receiveGraphTaskMessage({ taskId: request.taskId, sourceId: `interaction:${request.id}`,
      actorId: args.actor.id, actorOrigin: args.actor.channel === 'feishu' ? 'feishu' : 'platform', content: args.responseText?.trim() || '用户已回答原问题。' })) {
    await prisma.taskRunInteractionRequest.updateMany({ where: { id: request.id, status: 'pending' },
      data: { status: 'answered', resolvedAt: new Date(), responseText: args.responseText || null, responseMetadata: JSON.stringify({ actor: args.actor, delivery: 'graph_conversation_inbox' }) } });
    return { requestId: request.id, status: 'answered', resumed: false, continuationRunId: null };
  }
  const now = new Date();
  const ended = !['running', 'waiting_for_input'].includes(request.taskRun.status)
    || (request.taskSessionId && request.task.currentTaskSessionId !== request.taskSessionId);
  if (request.expiresAt && request.expiresAt <= now || ended) {
    const status = request.expiresAt && request.expiresAt <= now ? 'expired' : 'cancelled';
    await prisma.taskRunInteractionRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status, resolvedAt: now },
    });
    cancelInProcessApproval(request.id);
    throw new Error(`Interaction request is ${status}`);
  }
  const requestPayload = parseMetadata(request.rawPayload);
  if (args.action === 'approve'
    && request.requestKind === 'permission_request'
    && requestPayload.approvalSupported !== true) {
    throw new Error('This harness does not support in-process permission approval');
  }

  const participant =
    request.participant
    || (request.participantId
      ? request.taskRun.participants.find((row) => row.id === request.participantId) || null
      : null);

  const participantPayload = participant ? toParticipantEventPayload(participant) : null;
  const resolvedStatus: TaskRunInteractionRequestStatus =
    args.action === 'approve'
      ? 'approved'
      : args.action === 'deny'
      ? 'denied'
      : 'answered';

  const runningProcess = participant ? getRunningProcess(participant.id) : null;
  const canResolveInProcess = request.requestKind === 'permission_request'
    && participant?.executionBackend === 'platform_local'
    && participant.harnessType === 'codex'
    && (args.action === 'approve' || args.action === 'deny')
    && runningProcess?.child.exitCode === null
    && !runningProcess.child.killed;

  if (canResolveInProcess && participant) {
    const claimed = await prisma.taskRunInteractionRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: {
        status: resolvedStatus,
        responseText: args.responseText ?? null,
        responseMetadata: stringifyMetadata({ actor: args.actor, resumed: true, resumeStrategy: 'in_process' }),
        resolvedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new Error('Interaction request is already resolved');
    }
    if (!resolveInProcessApproval(request.id, args.action === 'approve' ? 'approve' : 'deny')) {
      await prisma.taskRunInteractionRequest.update({
        where: { id: request.id },
        data: {
          status: 'cancelled',
          responseMetadata: stringifyMetadata({ actor: args.actor, resumed: false, reason: 'process_exited' }),
        },
      });
      throw new Error('Interaction request is already resolved or the Codex process exited');
    }

    await Promise.all([
      prisma.taskRun.update({
        where: { id: request.taskRunId },
        data: { status: 'running', activityState: 'streaming', error: null },
      }),
      prisma.taskRunParticipant.update({
        where: { id: participant.id },
        data: { status: 'running', activityState: 'streaming', error: null },
      }),
      request.taskSessionId
        ? prisma.taskSession.update({
            where: { id: request.taskSessionId },
            data: { status: 'active', attentionState: 'normal' },
          })
        : Promise.resolve(),
    ]);

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      participantId: participant.id,
      participant: participantPayload,
      eventType: 'interaction_request_resolved',
      content: args.action === 'approve' ? 'Codex 权限请求已批准，原进程正在继续。' : 'Codex 权限请求已拒绝，原进程正在继续。',
      metadata: {
        interactionRequestId: request.id,
        requestKind: request.requestKind,
        requestStatus: resolvedStatus,
        resumed: true,
        resumeStrategy: 'in_process',
        actor: args.actor,
      },
    });

    return { requestId: request.id, status: resolvedStatus, resumed: true, continuationRunId: null };
  }

  if (!participant) {
    const updated = await prisma.taskRunInteractionRequest.update({
      where: { id: request.id },
      data: {
        status: resolvedStatus,
        responseText: args.responseText ?? null,
        responseMetadata: stringifyMetadata({
          actor: args.actor,
          resumed: false,
          reason: 'participant_missing',
        }),
        resolvedAt: new Date(),
      },
    });

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      participantId: request.participantId,
      participant: participantPayload,
      eventType: 'interaction_request_resolved',
      content: `交互请求已${resolvedStatus === 'denied' ? '拒绝' : '处理'}。`,
      metadata: {
        interactionRequestId: request.id,
        requestKind: request.requestKind,
        requestStatus: updated.status,
        resumed: false,
        actor: args.actor,
      },
    });

    return {
      requestId: updated.id,
      status: updated.status,
      resumed: false,
      continuationRunId: null,
    };
  }

  if (args.action === 'deny') {
    await prisma.taskRunInteractionRequest.update({
      where: { id: request.id },
      data: {
        status: 'denied',
        responseText: args.responseText ?? null,
        responseMetadata: stringifyMetadata({
          actor: args.actor,
          resumed: false,
          reason: 'denied_by_user',
        }),
        resolvedAt: new Date(),
      },
    });

    await prisma.taskRunParticipant.update({
      where: { id: participant.id },
      data: {
        status: 'failed',
        activityState: 'stalled',
        error: 'Denied by user',
      },
    }).catch(() => undefined);

    await prisma.taskRun.update({
      where: { id: request.taskRunId },
      data: {
        status: 'failed',
        activityState: 'stalled',
        error: 'Interaction request denied by user',
      },
    }).catch(() => undefined);

    if (request.taskSessionId) {
      await prisma.taskSession.update({
        where: { id: request.taskSessionId },
        data: {
          status: 'active',
          attentionState: 'normal',
        },
      }).catch(() => undefined);
    }

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      participantId: participant.id,
      participant: participantPayload,
      eventType: 'interaction_request_resolved',
      content: '交互请求已被用户拒绝，当前执行已停止。',
      metadata: {
        interactionRequestId: request.id,
        requestKind: request.requestKind,
        requestStatus: 'denied',
        resumed: false,
        actor: args.actor,
      },
    });

    return {
      requestId: request.id,
      status: 'denied',
      resumed: false,
      continuationRunId: null,
    };
  }

  const continuation = getContinuationSession(participant);
  const taskPermissionConfig = readTaskPermissionConfig(request.task.acpxPermissionConfig);
  const sessionPermissionConfig = resolveTaskSessionPermissionConfig({
    taskSession: request.taskSession,
    fallback: taskPermissionConfig,
  });
  const permissionConfig = sessionPermissionConfig;

  const continuationMessage = buildContinuationMessage({
    requestKind: request.requestKind,
    action: args.action,
    responseText: args.responseText,
  });

  let continuationRunId: string | null = null;
  let resumed = false;
  let resumeError: string | null = null;

  if (continuation.sessionId && continuationMessage) {
    try {
      const result = await executeAcpxTaskRunWithContinuationFallback({
        staleParticipantId: participant.id,
        request: {
          taskId: request.task.id,
          taskSessionId: request.taskRun.taskSessionId || request.task.currentTaskSessionId || undefined,
          taskName: request.task.name,
          taskDescription: request.task.description || undefined,
          orchestrationMode: 'single',
          workingDirectory: request.task.workingDirectory || undefined,
          permissionConfig,
          participants: [
            {
              gatewayId: participant.gatewayId || 'local',
              gatewayName: participant.gatewayNameSnapshot,
              executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
              harnessType: participant.harnessType,
              harnessLabel: participant.harnessNameSnapshot || undefined,
              role: participant.role,
              agentId: participant.agentId || undefined,
              agentName: participant.agentNameSnapshot || undefined,
              resumeSessionId: continuation.sessionId,
              continuationSessionKind: continuation.sessionKind || undefined,
              resumeThreadId:
                continuation.sessionKind === 'codex_thread' ? continuation.sessionId : undefined,
              continuationMessage,
            },
          ],
        },
      });

      continuationRunId = result.taskRunId;
      resumed = true;

      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId: result.taskRunId,
        participantId: participant.id,
        participant: participantPayload,
        eventType: 'session_continuation_started',
        content: `${participant.role} 正在继续同一个 ${participant.harnessType} 会话。`,
      metadata: {
        sourceRunId: request.taskRunId,
        interactionRequestId: request.id,
        sessionId: continuation.sessionId,
        sessionKind: continuation.sessionKind,
        actor: args.actor,
        sessionPermissionOverrideApplied: false,
        permissionProfile: permissionConfig.profile,
      },
    });
    } catch (error) {
      resumeError = error instanceof Error ? error.message : String(error);
    }
  } else {
    resumeError = 'Continuation session unavailable';
  }

  const updated = await prisma.taskRunInteractionRequest.update({
    where: { id: request.id },
    data: {
      status: resolvedStatus,
      responseText: args.responseText ?? null,
      responseMetadata: stringifyMetadata({
        actor: args.actor,
        resumed,
        continuationRunId,
        resumeError,
        sessionPermissionOverrideApplied: false,
        permissionConfig,
      }),
      resolvedAt: new Date(),
    },
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: request.taskRunId,
    participantId: participant.id,
    participant: participantPayload,
    eventType: 'interaction_request_resolved',
    content:
      resumed
        ? '交互请求已处理，平台已继续当前会话。'
        : '交互请求已处理，但当前未能自动继续会话。',
      metadata: {
        interactionRequestId: request.id,
        requestKind: request.requestKind,
        requestStatus: updated.status,
        resumed,
        continuationRunId,
        resumeError,
        actor: args.actor,
        sessionPermissionOverrideApplied: false,
        permissionProfile: permissionConfig.profile,
      },
    });

  return {
    requestId: updated.id,
    status: updated.status,
    resumed,
    continuationRunId,
    resumeError,
  };
};
