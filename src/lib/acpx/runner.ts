import { prisma } from '@/lib/prisma';
import type { ChildProcess } from 'child_process';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { executeCodexTask, resumeCodexSession } from '@/lib/real-agents/codex-agent';
import { executeClaudeTask } from '@/lib/real-agents/claude-agent';
import { buildTaskRoomContext } from '@/lib/task-room';
import { getHarnessCapabilities } from './capabilities';
import { publishTaskRunEvent } from './event-bus';
import {
  clearRunningProcess,
  consumeRunControlRequest,
  registerRunningProcess,
} from './process-registry';
import { ensureTaskSession, setTaskSessionActiveRun } from './session';
import type {
  AcpxLiveEventPayload,
  AcpxParticipantRequest,
  AcpxRunRequest,
  HarnessInteractionRequest,
  HarnessStreamCallbacks,
  RunControlAction,
  RunActivityState,
  TaskRunStatus,
  WatchdogConfig,
} from './types';

const parseModifiedFiles = (filesModified?: string[] | null) =>
  JSON.stringify(filesModified ?? []);

const DEFAULT_CODEX_MAX_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_CLAUDE_MAX_RUNTIME_MS = 10 * 60 * 1000;

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

const updateRunActivity = async (
  taskRunId: string,
  activityState: RunActivityState,
  fields?: Partial<{
    lastActivityAt: Date;
    lastStdoutAt: Date;
    lastStderrAt: Date;
  }>
) => {
  await prisma.taskRun.update({
    where: { id: taskRunId },
    data: {
      activityState,
      ...fields,
    },
  });
};

const updateParticipantActivity = async (
  participantId: string,
  activityState: RunActivityState,
  lastActivityAt?: Date
) => {
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      activityState,
      lastActivityAt,
    },
  });
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
            latestThreadId: threadId,
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
            latestThreadId: threadId,
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
      message: 'Harness 请求用户确认权限后继续。',
      rawContent: chunk,
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
      message: 'Harness 请求用户在多个选项中做选择。',
      rawContent: chunk,
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
      message: 'Harness 请求用户补充输入后继续。',
      rawContent: chunk,
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
}) => {
  const isWaitingUser =
    request.kind === 'permission_request'
    || request.kind === 'input_request'
    || request.kind === 'choice_request';

  await prisma.taskRun.update({
    where: { id: taskRunId },
    data: {
      status: isWaitingUser ? 'waiting_for_input' : undefined,
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      controlMetadata: stringifyJson({
        interactionRequest: {
          kind: request.kind,
          message: request.message,
          detectedAt: new Date().toISOString(),
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
        interactionRequest: {
          kind: request.kind,
          message: request.message,
          detectedAt: new Date().toISOString(),
        },
      }),
    },
  });

  const taskRun = await prisma.taskRun.findUnique({
    where: { id: taskRunId },
    select: { taskSessionId: true },
  });

  if (taskRun?.taskSessionId) {
    await prisma.taskSession.update({
      where: { id: taskRun.taskSessionId },
      data: {
        status: isWaitingUser ? 'waiting_user' : 'failed',
        attentionState: isWaitingUser ? 'needs_user_input' : 'error',
      },
    });
  }

  await publishTaskRunEvent({
    taskId,
    taskRunId,
    participantId,
    participant,
    eventType: 'control_message',
    content: request.message,
    metadata: {
      requestKind: request.kind,
      runStatus: isWaitingUser ? 'waiting_for_input' : 'failed',
      activityState: isWaitingUser ? 'waiting_user' : 'stalled',
      excerpt: request.rawContent.slice(0, 600),
    },
  });
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
  executionBackend: 'platform_local' | 'gateway_openclaw';
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

const buildHarnessPrompt = (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: string
) => {
  const priorContext =
    previousSummaries.length > 0
      ? `\n\nPrevious participant outputs:\n${previousSummaries
          .map((item, index) => `${index + 1}. ${item}`)
          .join('\n')}`
      : '';
  const roomContext = taskRoomContext
    ? `\n\nTask room context:\n${taskRoomContext}`
    : '';

  return `Task: ${request.taskName}

Role: ${participant.role}
Harness: ${participant.harnessType}
Gateway: ${participant.gatewayName || participant.gatewayId}
Execution Backend: ${participant.executionBackend}

Description:
${request.taskDescription || 'Please complete this task.'}${roomContext}${priorContext}

Work within your assigned role. If you are not the first participant, build on the previous participant outputs. End with a concise summary and list any modified files.`;
};

const executeViaGateway = async (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: string
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  threadId?: string;
}> => {
  const config = await getOpenClawGatewayConfig(participant.gatewayId);

  if (!config) {
    throw new Error(`Gateway "${participant.gatewayName || participant.gatewayId}" 未配置 OpenClaw`);
  }

  const response = await createOpenClawResponse(config, {
    input: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext),
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
  taskRoomContext: string,
  onSpawn?: (child: { pid?: number }) => void
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  threadId?: string;
}> => {
  const task = {
    id: request.taskId,
    name: request.taskName,
    description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext),
  };

  if (participant.harnessType === 'codex') {
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

    const result = participant.resumeThreadId && participant.continuationMessage
      ? (() => resumeCodexSession({
          threadId: participant.resumeThreadId,
          prompt: participant.continuationMessage,
          timeout: request.watchdogConfig?.maxRuntimeMs ?? DEFAULT_CODEX_MAX_RUNTIME_MS,
          workingDirectory: request.workingDirectory || process.cwd(),
          streamCallbacks: callbacks,
          onSpawn: registerSpawn,
          onThreadStarted: (threadId) => {
            void persistCodexThreadMetadata(taskRunId, participantId, threadId);
          },
        }))()
      : (() => executeCodexTask(task, {
          timeout: request.watchdogConfig?.maxRuntimeMs ?? DEFAULT_CODEX_MAX_RUNTIME_MS,
          workingDirectory: request.workingDirectory,
          streamCallbacks: callbacks,
          onSpawn: registerSpawn,
          onThreadStarted: (threadId) => {
            void persistCodexThreadMetadata(taskRunId, participantId, threadId);
          },
        }))();

    const resolved = await result;

    if ('success' in resolved && !resolved.success) {
      throw new Error(resolved.error || 'Codex execution failed');
    }

    return {
      output: resolved.output || 'Codex completed',
      filesModified: 'filesModified' in resolved ? (resolved.filesModified ?? []) : [],
      executionTime: 'executionTime' in resolved ? resolved.executionTime : 0,
      liveStreaming: true,
      threadId: resolved.threadId || undefined,
    };
  }

  if (participant.harnessType === 'claude') {
    const result = await executeClaudeTask(task, {
      timeout: request.watchdogConfig?.maxRuntimeMs ?? DEFAULT_CLAUDE_MAX_RUNTIME_MS,
      workingDirectory: request.workingDirectory,
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
    });

    if (!result.success) {
      throw new Error(result.error || 'Claude execution failed');
    }

    return {
      output: result.output || 'Claude completed',
      filesModified: result.filesModified ?? [],
      executionTime: result.executionTime,
      liveStreaming: true,
      threadId: undefined,
    };
  }

  throw new Error(`本地暂不支持 harness: ${participant.harnessType}`);
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
            controlMetadata: stringifyJson(capabilities),
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

  const callbacks: HarnessStreamCallbacks = {
    onStdoutChunk: async (chunk) => {
      const now = new Date();
      await updateRunActivity(taskRunId, 'streaming', {
        lastActivityAt: now,
        lastStdoutAt: now,
      });
      await updateParticipantActivity(participantId, 'streaming', now);

      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'stdout_chunk',
        stream: 'stdout',
        content: chunk,
      });

      const interactionRequest = detectHarnessInteractionRequest(chunk);
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
        });
      } else {
        await clearWaitingForInputIfNeeded(taskRunId, participantId);
      }
    },
    onStderrChunk: async (chunk) => {
      const now = new Date();
      await updateRunActivity(taskRunId, 'streaming', {
        lastActivityAt: now,
        lastStderrAt: now,
      });
      await updateParticipantActivity(participantId, 'streaming', now);

      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'stderr_chunk',
        stream: 'stderr',
        content: chunk,
      });

      const interactionRequest = detectHarnessInteractionRequest(chunk);
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
        });
      } else {
        await clearWaitingForInputIfNeeded(taskRunId, participantId);
      }
    },
  };

  try {
    const taskRoomContext = await buildTaskRoomContext(request.taskId, request.taskName, 30);
    const localSpawnHandler = (child: { pid?: number }) => {
      void persistSpawnedHarnessMetadata(taskRunId, participantId, child.pid);
    };

    const result = participant.executionBackend === 'platform_local'
      ? await executeViaLocalHarness(
          request,
          taskRunId,
          participantId,
          participant,
          callbacks,
          previousSummaries,
          taskRoomContext,
          localSpawnHandler
        )
      : await executeViaGateway(request, participant, previousSummaries, taskRoomContext);

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

    if (result.threadId) {
      await persistCodexThreadMetadata(taskRunId, participantId, result.threadId);
    }

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
