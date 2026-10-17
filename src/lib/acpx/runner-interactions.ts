import { prisma } from '@/lib/prisma';
import { sendFeishuApprovalCard } from '@/lib/feishu-api';
import { publishTaskRunEvent } from './event-bus';
import { cancelInProcessApproval, waitForInProcessApproval } from './in-process-approvals';
import {
  createTaskRunInteractionRequest,
  findRecentPendingInteractionRequest,
  isPermissionRequestWithinBoundary,
} from './interactions';
import { parseJsonObject, stringifyJson } from './runner-metadata';
import type { AcpxLiveEventPayload, AcpxRunRequest, HarnessInteractionRequest } from './types';

export const detectHarnessInteractionRequest = (chunk: string, harnessType: string): HarnessInteractionRequest | null => {
  // Structured adapters expose output, not terminal prompts. Native requests use onInteractionRequest.
  if (['codex', 'kimi-code', 'antigravity'].includes(harnessType)) return null;
  const normalized = chunk.toLowerCase();

  if (
    normalized.includes('只读环境') || normalized.includes('只读')
    || normalized.includes('read-only environment') || normalized.includes('read only environment')
    || normalized.includes('cannot modify') || normalized.includes('unable to modify')
    || normalized.includes('cannot edit') || normalized.includes('unable to edit')
  ) {
    return { kind: 'workspace_issue', message: 'Harness 报告当前工作区不可写，无法直接修改代码。', rawContent: chunk };
  }

  if (
    (normalized.includes('permission') && normalized.includes('?'))
    || normalized.includes('approve this action') || normalized.includes('allow this action')
    || normalized.includes('allow this command') || normalized.includes('grant access to')
    || normalized.includes('do you want to allow') || normalized.includes('需要你的确认')
    || normalized.includes('请确认是否允许')
  ) {
    return {
      kind: 'permission_request',
      title: 'Harness 请求权限确认',
      message: 'Harness 请求用户确认权限后继续。',
      rawContent: chunk,
      responseFormat: 'approve_deny',
      resumeStrategy: 'rerun_continuation',
    };
  }

  if (
    normalized.includes('select an option') || normalized.includes('choose an option')
    || normalized.includes('pick one') || normalized.includes('choose one of the following')
    || normalized.includes('请选择') || normalized.includes('选择一个')
  ) {
    return {
      kind: 'choice_request',
      title: 'Harness 请求用户选择选项',
      message: 'Harness 请求用户在多个选项中做选择。',
      rawContent: chunk,
      responseFormat: 'single_choice',
      resumeStrategy: 'rerun_continuation',
    };
  }

  if (
    normalized.includes('waiting for input') || normalized.includes('input required')
    || normalized.includes('need your input') || normalized.includes('please provide the following')
    || normalized.includes('please answer') || normalized.includes('请输入') || normalized.includes('请提供')
  ) {
    return {
      kind: 'input_request',
      title: 'Harness 请求补充输入',
      message: 'Harness 请求用户补充输入后继续。',
      rawContent: chunk,
      responseFormat: 'text',
      resumeStrategy: 'rerun_continuation',
    };
  }

  return null;
};

export const handleHarnessInteractionRequest = async ({
  request, taskId, taskRunId, participantId, participant, workingDirectory, permissionConfig,
}: {
  request: HarnessInteractionRequest;
  taskId: string; taskRunId: string; participantId: string;
  participant: NonNullable<AcpxLiveEventPayload['participant']>;
  workingDirectory: string;
  permissionConfig: NonNullable<AcpxRunRequest['permissionConfig']>;
}): Promise<'approve' | 'deny' | void> => {
  const isWaitingUser = request.kind === 'permission_request'
    || request.kind === 'input_request' || request.kind === 'choice_request';
  const approvalSupported = request.kind !== 'permission_request'
    || (request.resumeStrategy === 'in_process'
      && participant.executionBackend === 'platform_local'
      && participant.harnessType === 'codex');
  const workspaceBoundary = permissionConfig.profile === 'full_access'
    ? 'Full Access（已由管理员在启动前批准）'
    : permissionConfig.writableRoots[0] || workingDirectory;
  if (permissionConfig.profile !== 'full_access' && !isPermissionRequestWithinBoundary({
    ...request, workspaceBoundary,
  })) return 'deny';
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const [existingTaskRun, existingParticipant] = await Promise.all([
    prisma.taskRun.findUnique({ where: { id: taskRunId }, select: { controlMetadata: true, taskSessionId: true } }),
    prisma.taskRunParticipant.findUnique({ where: { id: participantId }, select: { controlMetadata: true } }),
  ]);
  const existingRequest = await findRecentPendingInteractionRequest({
    taskRunId, participantId, requestKind: request.kind, message: request.message,
  });

  const persistedRequest = existingRequest || await createTaskRunInteractionRequest({
    taskId,
    taskSessionId: existingTaskRun?.taskSessionId ?? null,
    taskRunId,
    participantId,
    source: 'harness',
    requestKind: request.kind,
    title: request.title ?? null,
    message: request.message,
    rawPayload: {
      rawContent: request.rawContent,
      responseFormat: request.responseFormat ?? null,
      resumeStrategy: request.resumeStrategy ?? null,
      command: request.rawContent.slice(0, 800),
      workdir: workingDirectory,
      workspaceBoundary,
      approvalScope: approvalSupported
        ? '仅本次操作；不修改 sandbox、network、writable roots 或 Workflow policy'
        : 'adapter 不支持原进程批准；只能拒绝或另行启动受支持的运行',
      approvalSupported,
    },
    options: request.options?.map((option) => ({
      id: option.id, label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })) ?? [],
    defaultAnswer: request.defaultOptionId ?? null,
    expiresAt,
  });
  const inProcessDecision = request.resumeStrategy === 'in_process'
    ? waitForInProcessApproval(persistedRequest.id)
    : null;
  const interactionRequestMetadata = {
    id: persistedRequest.id, kind: request.kind, message: request.message,
    detectedAt: new Date().toISOString(), status: persistedRequest.status,
  };
  await prisma.taskRun.update({
    where: { id: taskRunId },
    data: {
      status: isWaitingUser ? 'waiting_for_input' : undefined,
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      controlMetadata: stringifyJson({
        ...parseJsonObject(existingTaskRun?.controlMetadata),
        interactionRequest: interactionRequestMetadata,
      }),
    },
  });
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      status: isWaitingUser ? 'waiting_for_input' : undefined,
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      controlMetadata: stringifyJson({
        ...parseJsonObject(existingParticipant?.controlMetadata),
        interactionRequest: interactionRequestMetadata,
      }),
    },
  });

  if (existingTaskRun?.taskSessionId) {
    await prisma.taskSession.update({
      where: { id: existingTaskRun.taskSessionId },
      data: {
        status: isWaitingUser ? 'waiting_user' : 'failed',
        attentionState: isWaitingUser ? 'needs_user_input' : 'error',
      },
    });
  }
  if (!existingRequest) {
    await publishTaskRunEvent({
      taskId,
      taskRunId,
      participantId,
      participant,
      eventType: 'interaction_request_created',
      content: request.message,
      metadata: {
        interactionRequestId: persistedRequest.id,
        requestKind: request.kind,
        requestStatus: persistedRequest.status,
        responseFormat: request.responseFormat ?? null,
        resumeStrategy: request.resumeStrategy ?? null,
        excerpt: request.rawContent.slice(0, 600),
      },
    });

    // Push an approval card to the Feishu chat bound to this task's live room
    if (isWaitingUser) {
      prisma.feishuConversationBinding.findFirst({
        where: { liveRoom: { sourceTaskId: taskId } },
        select: { chatId: true, rootMessageId: true },
      }).then(async (binding) => {
        if (!binding) return;
        await sendFeishuApprovalCard({
          chatId: binding.chatId,
          threadRootMessageId: binding.rootMessageId || undefined,
          interactionRequestId: persistedRequest.id,
          command: request.rawContent.slice(0, 800),
          kind: request.kind,
          workdir: workingDirectory,
          workspaceBoundary,
          approvalScope: approvalSupported
            ? '仅批准启动策略边界内的本次操作'
            : '当前 adapter 不支持原进程批准',
          expiresAt: persistedRequest.expiresAt || expiresAt.toISOString(),
          approvalSupported,
        });
      }).catch((err) => {
        console.error('[runner] failed to send feishu approval card:', err);
      });
    }
  }

  await publishTaskRunEvent({
    taskId,
    taskRunId,
    participantId,
    participant,
    eventType: 'control_message',
    content: request.message,
    metadata: {
      interactionRequestId: persistedRequest.id,
      requestKind: request.kind,
      requestStatus: persistedRequest.status,
      runStatus: isWaitingUser ? 'waiting_for_input' : 'failed',
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      excerpt: request.rawContent.slice(0, 600),
    },
  });

  if (inProcessDecision) {
    try {
      const result = await inProcessDecision;
      if (result.timedOut) {
        await prisma.taskRunInteractionRequest.updateMany({
          where: { id: persistedRequest.id, status: 'pending' },
          data: { status: 'expired', resolvedAt: new Date() },
        });
      }
      return result.decision;
    } finally {
      cancelInProcessApproval(persistedRequest.id);
    }
  }
};

export const clearWaitingForInputIfNeeded = async (taskRunId: string, participantId: string) => {
  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { status: true, taskSessionId: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { status: true },
    }),
  ]);

  if (taskRun?.status === 'waiting_for_input') {
    await prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        status: 'running',
        activityState: 'streaming',
      },
    });

    if (taskRun.taskSessionId) {
      await prisma.taskSession.update({
        where: { id: taskRun.taskSessionId },
        data: {
          status: 'active',
          attentionState: 'normal',
        },
      });
    }
  }

  if (participant?.status === 'waiting_for_input') {
    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'running',
        activityState: 'streaming',
      },
    });
  }
};

export const toParticipantPayload = (participant: {
  gatewayId?: string | null;
  gatewayNameSnapshot: string;
  executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
  harnessType: string;
  harnessNameSnapshot?: string | null;
  role: string;
  agentId?: string | null;
  agentNameSnapshot?: string | null;
}): NonNullable<AcpxLiveEventPayload['participant']> => ({
  gatewayId: participant.gatewayId ?? null,
  gatewayName: participant.gatewayNameSnapshot,
  executionBackend: participant.executionBackend,
  harnessType: participant.harnessType,
  harnessLabel: participant.harnessNameSnapshot ?? null,
  role: participant.role,
  agentId: participant.agentId ?? null,
  agentName: participant.agentNameSnapshot ?? null,
});
