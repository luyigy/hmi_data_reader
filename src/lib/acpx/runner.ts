import { prisma } from '@/lib/prisma';
import type { ChildProcess } from 'child_process';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { getHarnessAdapter } from '@/lib/harness';
import { isClaudeHarnessType } from '@/lib/real-agents/claude-installations';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { executeRemoteSshTask } from '@/lib/remote-harness/ssh-executor';
import { buildTaskRoomPromptContext, countTaskRoomMessages } from '@/lib/task-room';
import { getHarnessCapabilities } from './capabilities';
import { DEFAULT_ACPX_PERMISSION_CONFIG, getLocalHarnessPermissionSupport } from './permissions';
import { publishTaskRunEvent } from './event-bus';
import {
  clearRunningProcess,
  consumeRunControlRequest,
  registerRunningProcess,
} from './process-registry';
import { getParticipantContinuationKey } from './session-tracking';
import { ensureTaskSession, setTaskSessionActiveRun } from './session';
import { createTaskRunInteractionRequest, findRecentPendingInteractionRequest } from './interactions';
import { sendFeishuApprovalCard } from '@/lib/feishu-api';
import { cancelInProcessApproval, waitForInProcessApproval } from './in-process-approvals';
import { createStreamWriteBuffer } from './stream-write-buffer';
import type {
  AcpxLiveEventPayload,
  AcpxParticipantRequest,
  AcpxRunRequest,
  HarnessInteractionRequest,
  HarnessStreamCallbacks,
  RunControlAction,
  TaskRunStatus,
  WatchdogConfig,
} from './types';

const parseModifiedFiles = (filesModified?: string[] | null) =>
  JSON.stringify(filesModified ?? []);

const DEFAULT_CODEX_MAX_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_CLAUDE_MAX_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_DEEPSEEK_MAX_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_GEMINI_MAX_RUNTIME_MS = 10 * 60 * 1000;

const resolveHarnessTimeout = (
  configuredTimeout: number | null | undefined,
  defaultTimeout: number
): number | null =>
  configuredTimeout === null
    ? null
    : typeof configuredTimeout === 'number'
    ? configuredTimeout
    : defaultTimeout;

const stringifyJson = (value?: Record<string, unknown> | WatchdogConfig | object | null) =>
  value ? JSON.stringify(value) : null;

const parseJsonObject = (value?: string | null) => {
  if (!value) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {} as Record<string, unknown>;
  }
};

const persistSpawnedHarnessMetadata = async (
  taskRunId: string,
  participantId: string,
  childPid: number | undefined
) => {
  if (!childPid) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...parseJsonObject(taskRun?.controlMetadata),
          activeLocalHarnessPid: childPid,
          localHarnessSpawnedAt: new Date().toISOString(),
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...parseJsonObject(participant?.controlMetadata),
          childPid,
          spawnedAt: new Date().toISOString(),
        }),
      },
    }),
  ]);
};

const persistCodexThreadMetadata = async (
  taskRunId: string,
  participantId: string,
  threadId: string | undefined
) => {
  if (!threadId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          codexThreadId: threadId,
          lastSessionThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'codex_thread',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootThreadId:
              typeof existingRunTracking.rootThreadId === 'string'
                ? existingRunTracking.rootThreadId
                : threadId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : threadId,
            latestThreadId: threadId,
            latestSessionId: threadId,
            latestSessionKind: 'codex_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootThreadId === 'string'
                ? existingRunTracking.rootThreadId === threadId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          codexThreadId: threadId,
          lastSessionThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'codex_thread',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootThreadId:
              typeof existingParticipantTracking.rootThreadId === 'string'
                ? existingParticipantTracking.rootThreadId
                : threadId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : threadId,
            latestThreadId: threadId,
            latestSessionId: threadId,
            latestSessionKind: 'codex_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootThreadId === 'string'
                ? existingParticipantTracking.rootThreadId === threadId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistClaudeSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionId: string | undefined
) => {
  if (!sessionId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          claudeSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'claude_session',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'claude_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          claudeSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'claude_session',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'claude_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistDeepSeekThreadMetadata = async (
  taskRunId: string,
  participantId: string,
  threadId: string | undefined
) => {
  if (!threadId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          deepseekThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'deepseek_thread',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : threadId,
            latestSessionId: threadId,
            latestSessionKind: 'deepseek_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === threadId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          deepseekThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'deepseek_thread',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : threadId,
            latestSessionId: threadId,
            latestSessionKind: 'deepseek_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === threadId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistGeminiSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionId: string | undefined
) => {
  if (!sessionId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          geminiSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'gemini_session',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'gemini_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          geminiSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'gemini_session',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'gemini_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistPlatformLocalSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionKind: string | undefined,
  sessionId: string | undefined,
  threadId?: string
) => {
  if (sessionKind === 'codex_thread') {
    await persistCodexThreadMetadata(taskRunId, participantId, threadId || sessionId);
    return;
  }

  if (sessionKind === 'claude_session') {
    await persistClaudeSessionMetadata(taskRunId, participantId, sessionId);
    return;
  }

  if (sessionKind === 'deepseek_thread') {
    await persistDeepSeekThreadMetadata(taskRunId, participantId, threadId || sessionId);
    return;
  }

  if (sessionKind === 'gemini_session') {
    await persistGeminiSessionMetadata(taskRunId, participantId, sessionId);
    return;
  }

  if (sessionKind === 'pi_session_dir' && sessionId) {
    const [taskRun, participant] = await Promise.all([
      prisma.taskRun.findUnique({
        where: { id: taskRunId },
        select: { controlMetadata: true },
      }),
      prisma.taskRunParticipant.findUnique({
        where: { id: participantId },
        select: { controlMetadata: true },
      }),
    ]);

    const now = new Date().toISOString();
    const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
    const participantMetadata = parseJsonObject(participant?.controlMetadata);
    const existingRunTracking =
      taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
        ? taskRunMetadata.sessionTracking as Record<string, unknown>
        : {};
    const existingParticipantTracking =
      participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
        ? participantMetadata.sessionTracking as Record<string, unknown>
        : {};

    await Promise.all([
      prisma.taskRun.update({
        where: { id: taskRunId },
        data: {
          controlMetadata: stringifyJson({
            ...taskRunMetadata,
            piSessionDir: sessionId,
            lastSessionId: sessionId,
            lastSessionKind: 'pi_session_dir',
            sessionTracking: {
              ...existingRunTracking,
              latestRunId: taskRunId,
              latestSessionId: sessionId,
              latestSessionKind: 'pi_session_dir',
              checkedAt: now,
            },
          }),
        },
      }),
      prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: {
          controlMetadata: stringifyJson({
            ...participantMetadata,
            piSessionDir: sessionId,
            lastSessionId: sessionId,
            lastSessionKind: 'pi_session_dir',
            sessionTracking: {
              ...existingParticipantTracking,
              latestParticipantId: participantId,
              latestSessionId: sessionId,
              latestSessionKind: 'pi_session_dir',
              checkedAt: now,
            },
          }),
        },
      }),
    ]);
  }
};

const mapControlActionToRunStatus = (action: RunControlAction): TaskRunStatus =>
  action === 'stop_run' ? 'stopped' : 'interrupted';

const detectHarnessInteractionRequest = (chunk: string): HarnessInteractionRequest | null => {
  const normalized = chunk.toLowerCase();

  if (
    normalized.includes('只读环境')
    || normalized.includes('只读')
    || normalized.includes('read-only environment')
    || normalized.includes('read only environment')
    || normalized.includes('cannot modify')
    || normalized.includes('unable to modify')
    || normalized.includes('cannot edit')
    || normalized.includes('unable to edit')
  ) {
    return {
      kind: 'workspace_issue',
      message: 'Harness 报告当前工作区不可写，无法直接修改代码。',
      rawContent: chunk,
    };
  }

  if (
    (normalized.includes('permission') && normalized.includes('?'))
    || normalized.includes('approve this action')
    || normalized.includes('allow this action')
    || normalized.includes('allow this command')
    || normalized.includes('grant access to')
    || normalized.includes('do you want to allow')
    || normalized.includes('需要你的确认')
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
    normalized.includes('select an option')
    || normalized.includes('choose an option')
    || normalized.includes('pick one')
    || normalized.includes('choose one of the following')
    || normalized.includes('请选择')
    || normalized.includes('选择一个')
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
    normalized.includes('waiting for input')
    || normalized.includes('input required')
    || normalized.includes('need your input')
    || normalized.includes('please provide the following')
    || normalized.includes('please answer')
    || normalized.includes('请输入')
    || normalized.includes('请提供')
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

const handleHarnessInteractionRequest = async ({
  request,
  taskId,
  taskRunId,
  participantId,
  participant,
}: {
  request: HarnessInteractionRequest;
  taskId: string;
  taskRunId: string;
  participantId: string;
  participant: NonNullable<AcpxLiveEventPayload['participant']>;
}): Promise<'approve' | 'deny' | void> => {
  const isWaitingUser =
    request.kind === 'permission_request'
    || request.kind === 'input_request'
    || request.kind === 'choice_request';

  const [existingTaskRun, existingParticipant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true, taskSessionId: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const existingRequest = await findRecentPendingInteractionRequest({
    taskRunId,
    participantId,
    requestKind: request.kind,
    message: request.message,
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
    },
    options: request.options?.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })) ?? [],
    defaultAnswer: request.defaultOptionId ?? null,
  });
  const inProcessDecision = request.resumeStrategy === 'in_process'
    ? waitForInProcessApproval(persistedRequest.id)
    : null;

  await prisma.taskRun.update({
    where: { id: taskRunId },
    data: {
      status: isWaitingUser ? 'waiting_for_input' : undefined,
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      controlMetadata: stringifyJson({
        ...parseJsonObject(existingTaskRun?.controlMetadata),
        interactionRequest: {
            id: persistedRequest.id,
            kind: request.kind,
            message: request.message,
            detectedAt: new Date().toISOString(),
            status: persistedRequest.status,
        },
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
        interactionRequest: {
            id: persistedRequest.id,
            kind: request.kind,
            message: request.message,
            detectedAt: new Date().toISOString(),
            status: persistedRequest.status,
        },
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
        select: { chatId: true },
      }).then(async (binding) => {
        if (!binding) return;
        await sendFeishuApprovalCard({
          chatId: binding.chatId,
          interactionRequestId: persistedRequest.id,
          command: request.rawContent.slice(0, 800),
          kind: request.kind,
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

const clearWaitingForInputIfNeeded = async (taskRunId: string, participantId: string) => {
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

const toParticipantPayload = (participant: {
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

/**
 * 去掉消息开头的 @提及 部分，作为双重保险
 * 例如: "@Platform Local Claude 你好" -> "你好"
 * 例如: "@main hello" -> "hello"
 *
 * 注意：这是最后的安全网，理想情况下 Task Room 中的内容已经被正确剥离
 */
const stripLeadingMention = (content: string): string => {
  // 如果不是以 @ 开头，直接返回
  if (!content.startsWith('@')) {
    return content;
  }

  // 使用贪婪匹配：@xxx yyy -> yyy
  // 贪婪匹配会尽可能多地匹配，直到最后一个空格后的内容
  const greedyMatch = content.match(/^@.+\s+([\s\S]+)$/);

  // 非贪婪匹配作为后备：@xxx yyy -> yyy (只匹配到第一个空格)
  const nonGreedyMatch = content.match(/^@\S+\s+([\s\S]*)$/);

  // 优先使用贪婪匹配的结果，但如果结果为空则使用非贪婪匹配
  let stripped = content;
  if (greedyMatch && greedyMatch[1].trim()) {
    stripped = greedyMatch[1].trim();
  } else if (nonGreedyMatch && nonGreedyMatch[1].trim()) {
    stripped = nonGreedyMatch[1].trim();
  }

  const debugLog = process.env.DEBUG_MENTION_DETECTION === 'true';
  if (debugLog && stripped !== content) {
    console.log('[buildHarnessPrompt] Double-insurance stripping @mention:', {
      original: content,
      stripped,
      method: greedyMatch && greedyMatch[1].trim() ? 'greedy' : 'non-greedy',
    });
  }

  return stripped;
};

// --- Context watermark heuristics ---
const CONTEXT_WARN_ROOM_MESSAGE_THRESHOLD = 40;
const CONTEXT_WARN_EVENT_THRESHOLD = 200;
const CONTEXT_WARN_TRANSCRIPT_NEAR_LIMIT = 3800; // 4000 char limit in task-room.ts
// Hard limits: beyond these thresholds the agent should compact NOW, not just warn.
const CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD = 60;
const CONTEXT_HARD_EVENT_THRESHOLD = 400;

const checkContextWatermark = async (
  taskId: string,
  taskName: string,
  taskRoomContext: { transcript: string },
  taskSessionId?: string
): Promise<string | null> => {
  const softReasons: string[] = [];
  const hardReasons: string[] = [];

  if (taskRoomContext.transcript.length >= CONTEXT_WARN_TRANSCRIPT_NEAR_LIMIT) {
    softReasons.push('对话记录已满');
  }

  const [roomMessageCount, eventCount] = await Promise.all([
    countTaskRoomMessages(taskId, taskName),
    prisma.taskRunEvent.count({
      where: taskSessionId
        ? { taskRun: { taskSessionId } }
        : { taskRun: { taskId } },
    }),
  ]);

  if (roomMessageCount >= CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD) {
    hardReasons.push(`任务室已有 ${roomMessageCount} 条消息`);
  } else if (roomMessageCount >= CONTEXT_WARN_ROOM_MESSAGE_THRESHOLD) {
    softReasons.push(`任务室已有 ${roomMessageCount} 条消息`);
  }

  if (eventCount >= CONTEXT_HARD_EVENT_THRESHOLD) {
    hardReasons.push(`已累计 ${eventCount} 条运行事件`);
  } else if (eventCount >= CONTEXT_WARN_EVENT_THRESHOLD) {
    softReasons.push(`已累计 ${eventCount} 条运行事件`);
  }

  if (hardReasons.length > 0) {
    return [
      `[系统警告] 当前 session 上下文已严重超载（${hardReasons.join('、')}）。`,
      `请在完成本次任务后立即执行以下操作：`,
      `1. 用 2-3 句话总结你到目前为止完成的工作和关键发现`,
      `2. 告知用户需要通过 /ap new-session 开始新 session 以避免上下文丢失`,
      `不要继续累积新的上下文，先完成当前指令，然后输出总结。`,
    ].join('\n');
  }

  if (softReasons.length > 0) {
    return `[系统提示] 当前 session 上下文已接近阈值（${softReasons.join('、')}），建议在合适时机执行 /ap new-session 切换新 session。`;
  }

  return null;
};
// ------------------------------------

const buildHarnessPrompt = (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  contextWarning?: string | null
) => {
  // 双重保险：确保最新指令不包含开头的 @提及
  const latestInstructionContent = taskRoomContext.latestUserMessage
    ? stripLeadingMention(taskRoomContext.latestUserMessage.content)
    : '';

  const debugLog = process.env.DEBUG_MENTION_DETECTION === 'true';
  if (debugLog && taskRoomContext.latestUserMessage) {
    console.log('[buildHarnessPrompt] Latest user message from Task Room:', {
      original: taskRoomContext.latestUserMessage.content,
      stripped: latestInstructionContent,
    });
  }

  const latestInstruction = latestInstructionContent
    ? `\n\nLatest task-room instruction (highest priority for this run):\n${latestInstructionContent}`
    : '';
  const taskBackground = request.taskDescription
    ? `\n\nTask background:\n${request.taskDescription}`
    : '';
  const roomTranscript = taskRoomContext.transcript
    ? `\n\nRecent task-room transcript:\n${taskRoomContext.transcript}`
    : '';
  const priorContext =
    previousSummaries.length > 0
      ? `\n\nPrevious participant outputs:\n${previousSummaries
          .map((item, index) => `${index + 1}. ${item}`)
          .join('\n')}`
      : '';

  const warningSection = contextWarning ? `\n\n${contextWarning}` : '';

  return `Task: ${request.taskName}

Role: ${participant.role}
Harness: ${participant.harnessType}
Target: ${participant.gatewayName || participant.gatewayId}
Execution Backend: ${participant.executionBackend}

You are being launched from a chat-first task room.
Use the latest task-room instruction as the primary direction for this run.
Treat the task background as stable context, and use the recent transcript to resolve details and intent.${latestInstruction}${taskBackground}${roomTranscript}${priorContext}${warningSection}

Work within your assigned role. If you are not the first participant, build on the previous participant outputs. End with a concise summary and list any modified files.`;
};

const executeViaGateway = async (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  contextWarning?: string | null
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const config = await getOpenClawGatewayConfig(participant.gatewayId);

  if (!config) {
    throw new Error(`Gateway "${participant.gatewayName || participant.gatewayId}" 未配置 OpenClaw`);
  }

  const response = await createOpenClawResponse(config, {
    input: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
    agentId: participant.agentId,
    model: participant.agentId ? `openclaw:${participant.agentId}` : undefined,
    sessionKey: `task:${request.taskId}:gateway:${participant.gatewayId}`,
  });

  return {
    output: extractOpenClawText(response) || JSON.stringify(response, null, 2),
    filesModified: [] as string[],
    executionTime: 0,
    liveStreaming: false,
    threadId: undefined,
  };
};

const executeViaLocalHarness = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  callbacks: HarnessStreamCallbacks,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  onSpawn?: (child: { pid?: number }) => void,
  contextWarning?: string | null
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const task = {
    id: request.taskId,
    name: request.taskName,
    description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
  };
  const adapter = getHarnessAdapter(participant.harnessType);
  if (!adapter) {
    throw new Error(`本地暂不支持 harness: ${participant.harnessType}`);
  }
  const permissionConfig = request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG;
  const workspaceRoot = permissionConfig.profile === 'full_access' ? undefined : permissionConfig.writableRoots[0];
  if (workspaceRoot && !['codex', 'claude', 'claude-haha'].includes(participant.harnessType)) {
    throw new Error(`受限 Feishu 工作区暂不支持 harness: ${participant.harnessType}`);
  }
  if (workspaceRoot && participant.harnessType === 'codex' && permissionConfig.approvalPolicy === 'on-request') {
    throw new Error('受限 Feishu 工作区暂不支持 Codex on-request app-server 模式。');
  }

  const registerSpawn = (child: ChildProcess) => {
    registerRunningProcess({
      taskRunId,
      participantId,
      child,
      executionBackend: participant.executionBackend,
      harnessType: participant.harnessType,
    });
    onSpawn?.(child);
  };

  const defaultTimeout =
    participant.harnessType === 'codex'
      ? DEFAULT_CODEX_MAX_RUNTIME_MS
      : participant.harnessType === 'deepseek'
      ? DEFAULT_DEEPSEEK_MAX_RUNTIME_MS
      : participant.harnessType === 'gemini-cli'
      ? DEFAULT_GEMINI_MAX_RUNTIME_MS
      : DEFAULT_CLAUDE_MAX_RUNTIME_MS;

  const result = participant.continuationMessage && adapter.resume && (participant.resumeSessionId || participant.resumeThreadId)
    ? await adapter.resume({
        task,
        sessionId: participant.resumeSessionId || participant.resumeThreadId || '',
        continuationMessage: participant.continuationMessage,
        context: {
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          networkAccess: permissionConfig.networkAccess,
          executionBackend: participant.executionBackend,
          permissionConfig,
          timeout: resolveHarnessTimeout(request.watchdogConfig?.maxRuntimeMs, defaultTimeout),
          ephemeralSession: participant.ephemeralSession,
          codexHome: participant.codexHome,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          sessionKey: getParticipantContinuationKey({
            continuationKey: participant.continuationKey,
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }),
          streamCallbacks: callbacks,
          onSpawn: registerSpawn,
          onSessionStarted: (session) => {
            void persistPlatformLocalSessionMetadata(
              taskRunId,
              participantId,
              session.sessionKind,
              session.sessionId,
              session.threadId
            );
          },
        },
      })
    : await adapter.execute({
        task,
        context: {
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          networkAccess: permissionConfig.networkAccess,
          executionBackend: participant.executionBackend,
          permissionConfig,
          timeout: resolveHarnessTimeout(request.watchdogConfig?.maxRuntimeMs, defaultTimeout),
          ephemeralSession: participant.ephemeralSession,
          codexHome: participant.codexHome,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          sessionKey: getParticipantContinuationKey({
            continuationKey: participant.continuationKey,
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }),
          streamCallbacks: callbacks,
          onSpawn: registerSpawn,
          onSessionStarted: (session) => {
            void persistPlatformLocalSessionMetadata(
              taskRunId,
              participantId,
              session.sessionKind,
              session.sessionId,
              session.threadId
            );
          },
        },
      });

  if (!result.success) {
    throw new Error(result.error || `${adapter.displayName} execution failed`);
  }

  return {
    output: result.output || `${adapter.displayName} completed`,
    filesModified: result.filesModified ?? [],
    executionTime: result.executionTime,
    liveStreaming: result.liveStreaming ?? false,
    sessionId: result.sessionId,
    sessionKind: result.sessionKind,
    threadId: result.threadId,
  };
};

const executeViaRemoteSshHarness = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  callbacks: HarnessStreamCallbacks,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  onSpawn?: (child: { pid?: number }) => void,
  contextWarning?: string | null
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const remoteHost = await getRemoteHarnessHostById(participant.gatewayId);

  if (!remoteHost) {
    throw new Error(`Remote SSH host not found: ${participant.gatewayId}`);
  }

  if (!remoteHost.supportedHarnesses.includes(participant.harnessType.toLowerCase())) {
    throw new Error(
      `Remote SSH host "${remoteHost.label}" does not declare harness "${participant.harnessType}"`
    );
  }

  return executeRemoteSshTask(
    {
      id: request.taskId,
      name: request.taskName,
      description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
    },
    {
      timeout: resolveHarnessTimeout(
        request.watchdogConfig?.maxRuntimeMs,
        isClaudeHarnessType(participant.harnessType)
          ? DEFAULT_CLAUDE_MAX_RUNTIME_MS
          : DEFAULT_CODEX_MAX_RUNTIME_MS
      ) ?? (isClaudeHarnessType(participant.harnessType)
        ? DEFAULT_CLAUDE_MAX_RUNTIME_MS
        : DEFAULT_CODEX_MAX_RUNTIME_MS),
      harnessType: participant.harnessType,
      host: remoteHost,
      resumeSessionId: participant.resumeSessionId || participant.resumeThreadId,
      continuationMessage: participant.resumeSessionId ? participant.continuationMessage : undefined,
      model: participant.model,
      reasoningEffort: participant.reasoningEffort,
      streamCallbacks: callbacks,
      onSpawn: (child) => {
        registerRunningProcess({
          taskRunId,
          participantId,
          child,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
        });
        onSpawn?.(child);
      },
    }
  );
};

export const executeAcpxTaskRun = async (request: AcpxRunRequest) => {
  const taskSession =
    request.taskSessionId
      ? await prisma.taskSession.findUnique({ where: { id: request.taskSessionId } })
      : await ensureTaskSession(request.taskId, {
          taskName: request.taskName,
          metadata: {
            executionMode: 'acpx',
          },
        });

  if (!taskSession) {
    throw new Error(`Task session not found for task "${request.taskId}"`);
  }

  const taskRun = await prisma.taskRun.create({
    data: {
      taskId: request.taskId,
      taskSessionId: taskSession.id,
      mode: 'acpx',
      orchestrationMode: request.orchestrationMode,
      status: 'running',
      activityState: 'quiet',
      watchdogConfig: stringifyJson(request.watchdogConfig ?? null),
      controlMetadata: stringifyJson({
        permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
        permissionSupport: request.participants.map((participant) => ({
          participantKey: `${participant.executionBackend}:${participant.harnessType}:${participant.role}`,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
          role: participant.role,
          support: getLocalHarnessPermissionSupport(
            participant.harnessType,
            participant.executionBackend
          ),
        })),
      }),
      lastActivityAt: new Date(),
      startedAt: new Date(),
      participants: {
        create: request.participants.map((participant) => {
          const capabilities = getHarnessCapabilities(
            participant.harnessType,
            participant.executionBackend
          );

          return {
            gatewayId: participant.gatewayId,
            gatewayNameSnapshot: participant.gatewayName || participant.gatewayId,
            executionBackend: participant.executionBackend,
            harnessType: participant.harnessType,
            harnessNameSnapshot: participant.harnessLabel || participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
            agentNameSnapshot: participant.agentName || null,
            runner: participant.harnessType,
            status: 'pending',
            activityState: 'quiet',
            interruptSupported: capabilities.supportsImmediateInterrupt,
            resumeSupported: capabilities.supportsResumeAfterInterrupt,
            sessionControlSupported: capabilities.supportsLiveSessionControl,
            softStopSupported: capabilities.supportsSoftStop,
            controlMetadata: stringifyJson({
              ...capabilities,
              continuationKey: getParticipantContinuationKey(participant),
              permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
              permissionSupport: getLocalHarnessPermissionSupport(
                participant.harnessType,
                participant.executionBackend
              ),
            }),
          };
        }),
      },
    },
    include: {
      participants: true,
    },
  });

  await setTaskSessionActiveRun(taskSession.id, taskRun.id);

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: taskRun.id,
    eventType: 'runner_started',
    content: `ACPX 运行开始，共 ${request.participants.length} 个参与方`,
      metadata: {
        mode: 'acpx',
        taskSessionId: taskSession.id,
        orchestrationMode: request.orchestrationMode,
        workingDirectory: request.workingDirectory ?? null,
        permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
        permissionSupport: request.participants.map((participant) => ({
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
          role: participant.role,
          support: getLocalHarnessPermissionSupport(
            participant.harnessType,
            participant.executionBackend
          ),
        })),
        watchdogConfig: request.watchdogConfig ?? null,
        participants: request.participants,
      },
  });

  const previousSummaries: string[] = [];
  const participantResults: Array<Awaited<ReturnType<typeof executeParticipant>>> = [];

  for (let index = 0; index < taskRun.participants.length; index += 1) {
    const participantRecord = taskRun.participants[index];
    const requestParticipant = request.participants[index];
    const result = await executeParticipant(
      request,
      taskRun.id,
      participantRecord.id,
      requestParticipant,
      previousSummaries
    );
    participantResults.push(result);
    if (result.summary) {
      previousSummaries.push(
        `${requestParticipant.role} @ ${requestParticipant.gatewayName || requestParticipant.gatewayId} / ${requestParticipant.harnessType}: ${result.summary}`
      );
    }

    if (result.status === 'interrupted' || result.status === 'stopped') {
      break;
    }
  }

  const failedParticipants = participantResults.filter((result) => result.status === 'failed');
  const completedParticipants = participantResults.filter((result) => result.status === 'completed');
  const interruptedParticipant = participantResults.find((result) => result.status === 'interrupted');
  const stoppedParticipant = participantResults.find((result) => result.status === 'stopped');
  const runStatus: TaskRunStatus = stoppedParticipant
    ? 'stopped'
    : interruptedParticipant
    ? 'interrupted'
    : failedParticipants.length > 0
    ? 'failed'
    : 'completed';
  const summaryLines = participantResults.map((result) =>
    `${result.role} @ ${result.gatewayName} / ${result.harnessType}: ${
      result.status === 'completed' ? result.summary || '完成' : result.error || '失败'
    }`
  );

  await prisma.taskRun.update({
    where: { id: taskRun.id },
    data: {
      status: runStatus,
      activityState: runStatus === 'completed' ? 'quiet' : 'stalled',
      completedAt: new Date(),
      summary: summaryLines.join('\n'),
      error:
        runStatus === 'failed'
          ? `${failedParticipants.length} participant(s) failed`
          : runStatus === 'interrupted'
          ? 'Run interrupted by user'
          : runStatus === 'stopped'
          ? 'Run stopped by user'
          : null,
    },
  });

  await prisma.taskSession.update({
    where: { id: taskSession.id },
    data: {
      status: runStatus === 'completed' ? 'active' : 'failed',
      attentionState:
        runStatus === 'completed'
          ? 'normal'
          : runStatus === 'interrupted' || runStatus === 'stopped'
          ? 'needs_review'
          : 'error',
      summary: summaryLines.join('\n'),
      activeRunId: null,
    },
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: taskRun.id,
    eventType:
      runStatus === 'completed'
        ? 'run_completed'
        : runStatus === 'interrupted'
        ? 'run_interrupted'
        : runStatus === 'stopped'
        ? 'run_stopped'
        : 'run_failed',
    content:
      runStatus === 'completed'
        ? `ACPX 运行完成，成功 ${completedParticipants.length} 个参与方`
        : runStatus === 'interrupted'
        ? 'ACPX 运行已被用户立即介入中断'
        : runStatus === 'stopped'
        ? 'ACPX 运行已被用户停止'
        : `ACPX 运行失败，失败 ${failedParticipants.length} 个参与方`,
    metadata: {
      summaries: participantResults,
    },
  });

  return {
    taskRunId: taskRun.id,
    status: runStatus,
    summary: summaryLines.join('\n'),
    participants: participantResults,
  };
};

const executeParticipant = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  previousSummaries: string[]
) => {
  const registryParticipantId = participantId;

  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      status: 'running',
      activityState: 'quiet',
      lastActivityAt: new Date(),
      startedAt: new Date(),
    },
  });

  const participantPayload = toParticipantPayload({
    gatewayId: participant.gatewayId,
    gatewayNameSnapshot: participant.gatewayName || participant.gatewayId,
    executionBackend: participant.executionBackend,
    harnessType: participant.harnessType,
    harnessNameSnapshot: participant.harnessLabel || participant.harnessType,
    role: participant.role,
    agentId: participant.agentId,
    agentNameSnapshot: participant.agentName || null,
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId,
    participantId,
    participant: participantPayload,
    eventType: 'participant_started',
    content: `${participant.role} 开始执行 (${participantPayload.gatewayName} / ${participant.harnessType})`,
  });

  const streamWrites = createStreamWriteBuffer(async (writes) => {
    const now = new Date();
    const hasStdout = writes.some(({ stream }) => stream === 'stdout');
    const hasStderr = writes.some(({ stream }) => stream === 'stderr');
    await prisma.$transaction([
      prisma.taskRun.update({
        where: { id: taskRunId },
        data: {
          activityState: 'streaming',
          lastActivityAt: now,
          lastStdoutAt: hasStdout ? now : undefined,
          lastStderrAt: hasStderr ? now : undefined,
        },
      }),
      prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: { activityState: 'streaming', lastActivityAt: now },
      }),
    ]);
    for (const write of writes) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: `${write.stream}_chunk`,
        stream: write.stream,
        content: write.content,
      });
    }
    if (writes.some(({ interactionDetected }) => !interactionDetected)) {
      await clearWaitingForInputIfNeeded(taskRunId, participantId);
    }
  });

  const callbacks: HarnessStreamCallbacks = {
    onStdoutChunk: async (chunk) => {
      const interactionRequest = detectHarnessInteractionRequest(chunk);
      streamWrites.push({ stream: 'stdout', content: chunk, interactionDetected: Boolean(interactionRequest) });
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
        });
      }

      if (request.streamCallbacks?.onStdoutChunk) {
        try {
          await request.streamCallbacks.onStdoutChunk(chunk);
        } catch (error) {
          console.error('[ACPX] request stdout stream callback failed:', error);
        }
      }
    },
    onStderrChunk: async (chunk) => {
      const interactionRequest = detectHarnessInteractionRequest(chunk);
      streamWrites.push({ stream: 'stderr', content: chunk, interactionDetected: Boolean(interactionRequest) });
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
        });
      }

      if (request.streamCallbacks?.onStderrChunk) {
        try {
          await request.streamCallbacks.onStderrChunk(chunk);
        } catch (error) {
          console.error('[ACPX] request stderr stream callback failed:', error);
        }
      }
    },
    onToolEvent: request.streamCallbacks?.onToolEvent
      ? (event) => { void request.streamCallbacks!.onToolEvent!(event); }
      : undefined,
    onInteractionRequest: participant.executionBackend === 'platform_local'
      && participant.harnessType === 'codex'
      ? async (interactionRequest) => {
          const decision = await handleHarnessInteractionRequest({
            request: interactionRequest,
            taskId: request.taskId,
            taskRunId,
            participantId,
            participant: participantPayload,
          });
          return decision || 'deny';
        }
      : undefined,
  };

  try {
    const taskRoomContext = await buildTaskRoomPromptContext(request.taskId, request.taskName, 30);
    const contextWarning = await checkContextWatermark(
      request.taskId,
      request.taskName,
      taskRoomContext,
      request.taskSessionId
    );
    const localSpawnHandler = (child: { pid?: number }) => {
      if (participant.executionBackend === 'platform_local') {
        void persistSpawnedHarnessMetadata(taskRunId, participantId, child.pid);
      }
    };

    const result =
      participant.executionBackend === 'platform_local'
        ? await executeViaLocalHarness(
            request,
            taskRunId,
            participantId,
            participant,
            callbacks,
            previousSummaries,
            taskRoomContext,
            localSpawnHandler,
            contextWarning
          )
        : participant.executionBackend === 'remote_ssh'
        ? await executeViaRemoteSshHarness(
            request,
            taskRunId,
            participantId,
            participant,
            callbacks,
            previousSummaries,
            taskRoomContext,
            localSpawnHandler,
            contextWarning
          )
        : await executeViaGateway(request, participant, previousSummaries, taskRoomContext, contextWarning);

    await streamWrites.drain();

    clearRunningProcess(registryParticipantId);

    if (!result.liveStreaming) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'stdout_chunk',
        stream: 'stdout',
        content: result.output,
        metadata: {
          note: 'Gateway OpenClaw execution currently returns final output after completion.',
        },
      });
    }

    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'completed',
        activityState: 'quiet',
        completedAt: new Date(),
        summary: result.output,
        filesModified: parseModifiedFiles(result.filesModified),
      },
    });

    await persistPlatformLocalSessionMetadata(
      taskRunId,
      participantId,
      result.sessionKind,
      result.sessionId,
      result.threadId
    );

    if (result.filesModified?.length) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'file_modified',
        content: result.filesModified.join('\n'),
        metadata: {
          filesModified: result.filesModified,
        },
      });
    }

    if (!result.liveStreaming) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'summary',
        content: result.output,
        metadata: {
          filesModified: result.filesModified ?? [],
          executionTime: result.executionTime,
          streamingMode: result.liveStreaming ? 'live' : 'final-only',
        },
      });
    }

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId,
      participantId,
      participant: participantPayload,
      eventType: 'participant_completed',
      content: `${participant.role} 执行完成`,
    });

    return {
      participantId,
      gatewayId: participant.gatewayId,
      gatewayName: participantPayload.gatewayName,
      harnessType: participant.harnessType,
      role: participant.role,
      status: 'completed' as const,
      summary: result.output,
      filesModified: result.filesModified ?? [],
      executionTime: result.executionTime,
    };
  } catch (error) {
    try {
      await streamWrites.drain();
    } catch (streamError) {
      console.error('[ACPX] Failed to persist buffered stream output:', streamError);
    }
    clearRunningProcess(registryParticipantId);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const requestedControl = consumeRunControlRequest(registryParticipantId);

    if (requestedControl) {
      const controlledStatus = mapControlActionToRunStatus(requestedControl);

      await prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: {
          status: controlledStatus,
          activityState: 'terminating',
          completedAt: new Date(),
          error: requestedControl === 'stop_run' ? 'Stopped by user' : 'Interrupted by user',
        },
      });

      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: requestedControl === 'stop_run' ? 'participant_stopped' : 'participant_interrupted',
        content: requestedControl === 'stop_run' ? `${participant.role} 已被用户停止` : `${participant.role} 已被用户中断`,
        metadata: {
          controlAction: requestedControl,
        },
      });

      return {
        participantId,
        gatewayId: participant.gatewayId,
        gatewayName: participantPayload.gatewayName,
        harnessType: participant.harnessType,
        role: participant.role,
        status: controlledStatus,
        error: requestedControl === 'stop_run' ? 'Stopped by user' : 'Interrupted by user',
        filesModified: [],
      };
    }

    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'failed',
        activityState: 'stalled',
        completedAt: new Date(),
        error: message,
      },
    });

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId,
      participantId,
      participant: participantPayload,
      eventType: 'participant_failed',
      content: `${participant.role} 执行失败: ${message}`,
      metadata: {
        error: message,
      },
    });

    return {
      participantId,
      gatewayId: participant.gatewayId,
      gatewayName: participantPayload.gatewayName,
      harnessType: participant.harnessType,
      role: participant.role,
      status: 'failed' as const,
      error: message,
      filesModified: [],
    };
  }
};
