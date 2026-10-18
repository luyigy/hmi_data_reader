import type { Prisma } from '@prisma/client';
import { bindExecutionTaskRun } from '../task-graph/execution-progress';
import { prisma } from '@/lib/prisma';
import { getHarnessCapabilities } from './capabilities';
import { publishTaskRunEvent } from './event-bus';
import { getLongFileRuntimeContext } from './long-file-runtime-context';
import { DEFAULT_ACPX_PERMISSION_CONFIG, getLocalHarnessPermissionSupport } from './permissions';
import { executeParticipant } from './runner-participant';
import { stringifyJson } from './runner-metadata';
import { getParticipantContinuationKey } from './session-tracking';
import { ensureTaskSession, setTaskSessionActiveRun } from './session';
import type { AcpxRunRequest, TaskRunStatus } from './types';

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

  const createRun = (tx: Pick<Prisma.TransactionClient, 'taskRun'>) => tx.taskRun.create({
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

  const graphExecution = request.graphExecution;
  const taskRun = graphExecution ? await prisma.$transaction(async tx => {
    const created = await createRun(tx);
    await bindExecutionTaskRun(tx, graphExecution, created.id);
    return created;
  }) : await createRun(prisma);

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
  const longFileContext = request.participants.some((participant) => participant.executionBackend === 'platform_local') ? await getLongFileRuntimeContext({ executionBackend: 'platform_local', workingDirectory: request.workingDirectory }) : null;
  const participantResults: Array<Awaited<ReturnType<typeof executeParticipant>>> = [];

  for (let index = 0; index < taskRun.participants.length; index += 1) {
    const participantRecord = taskRun.participants[index];
    const requestParticipant = request.participants[index];
    const result = await executeParticipant(
      request,
      taskRun.id,
      participantRecord.id,
      requestParticipant,
      previousSummaries, longFileContext,
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
