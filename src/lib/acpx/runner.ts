import { prisma } from '@/lib/prisma';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { executeCodexTask } from '@/lib/real-agents/codex-agent';
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

const mapControlActionToRunStatus = (action: RunControlAction): TaskRunStatus =>
  action === 'stop_run' ? 'stopped' : 'interrupted';

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
) => {
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
  };
};

const executeViaLocalHarness = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  callbacks: HarnessStreamCallbacks,
  previousSummaries: string[],
  taskRoomContext: string
) => {
  const task = {
    id: request.taskId,
    name: request.taskName,
    description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext),
  };

  if (participant.harnessType === 'codex') {
    const result = await executeCodexTask(task, {
      timeout: request.watchdogConfig?.maxRuntimeMs ?? DEFAULT_CODEX_MAX_RUNTIME_MS,
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
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'Codex execution failed');
    }

    return {
      output: result.output || 'Codex completed',
      filesModified: result.filesModified ?? [],
      executionTime: result.executionTime,
      liveStreaming: true,
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
    },
  };

  try {
    const taskRoomContext = await buildTaskRoomContext(request.taskId, request.taskName, 30);

    const result = participant.executionBackend === 'platform_local'
      ? await executeViaLocalHarness(
          request,
          taskRunId,
          participantId,
          participant,
          callbacks,
          previousSummaries,
          taskRoomContext
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
