import { prisma } from '@/lib/prisma';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { executeCodexTask } from '@/lib/real-agents/codex-agent';
import { executeClaudeTask } from '@/lib/real-agents/claude-agent';
import { buildTaskRoomContext } from '@/lib/task-room';
import { publishTaskRunEvent } from './event-bus';
import type {
  AcpxLiveEventPayload,
  AcpxParticipantRequest,
  AcpxRunRequest,
  HarnessStreamCallbacks,
  TaskRunStatus,
} from './types';

const parseModifiedFiles = (filesModified?: string[] | null) =>
  JSON.stringify(filesModified ?? []);

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
      timeout: 60000,
      workingDirectory: request.workingDirectory,
      streamCallbacks: callbacks,
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
      timeout: 120000,
      workingDirectory: request.workingDirectory,
      streamCallbacks: callbacks,
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
  const taskRun = await prisma.taskRun.create({
    data: {
      taskId: request.taskId,
      mode: 'acpx',
      orchestrationMode: request.orchestrationMode,
      status: 'running',
      startedAt: new Date(),
      participants: {
        create: request.participants.map((participant) => ({
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
        })),
      },
    },
    include: {
      participants: true,
    },
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: taskRun.id,
    eventType: 'runner_started',
    content: `ACPX 运行开始，共 ${request.participants.length} 个参与方`,
    metadata: {
      mode: 'acpx',
      orchestrationMode: request.orchestrationMode,
      workingDirectory: request.workingDirectory ?? null,
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
  }

  const failedParticipants = participantResults.filter((result) => result.status === 'failed');
  const completedParticipants = participantResults.filter((result) => result.status === 'completed');
  const runStatus: TaskRunStatus = failedParticipants.length > 0 ? 'failed' : 'completed';
  const summaryLines = participantResults.map((result) =>
    `${result.role} @ ${result.gatewayName} / ${result.harnessType}: ${
      result.status === 'completed' ? result.summary || '完成' : result.error || '失败'
    }`
  );

  await prisma.taskRun.update({
    where: { id: taskRun.id },
    data: {
      status: runStatus,
      completedAt: new Date(),
      summary: summaryLines.join('\n'),
      error: failedParticipants.length > 0 ? `${failedParticipants.length} participant(s) failed` : null,
    },
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: taskRun.id,
    eventType: runStatus === 'completed' ? 'run_completed' : 'run_failed',
    content:
      runStatus === 'completed'
        ? `ACPX 运行完成，成功 ${completedParticipants.length} 个参与方`
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
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      status: 'running',
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
      ? await executeViaLocalHarness(request, participant, callbacks, previousSummaries, taskRoomContext)
      : await executeViaGateway(request, participant, previousSummaries, taskRoomContext);

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
    const message = error instanceof Error ? error.message : 'Unknown error';

    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'failed',
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
