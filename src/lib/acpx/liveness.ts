import { promises as fs } from 'fs';
import { prisma } from '@/lib/prisma';
import { publishTaskRunEvent } from './event-bus';
import { getRunningProcess } from './process-registry';
import type { TaskRunStatus } from './types';

const LOCAL_STALE_GRACE_MS = 30 * 1000;

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

const mapControlStateToTerminalRunStatus = (controlState: string | null | undefined): TaskRunStatus => {
  if (controlState === 'stop_requested') {
    return 'stopped';
  }

  if (controlState === 'interrupt_requested') {
    return 'interrupted';
  }

  return 'failed';
};

const getParticipantTerminalStatus = (runStatus: TaskRunStatus) =>
  runStatus === 'stopped' ? 'stopped' : runStatus === 'interrupted' ? 'interrupted' : 'failed';

const pidLooksLikeHarness = async (pid: number, harnessType: string) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    const normalized = cmdline.replace(/\0/g, ' ').toLowerCase();

    if (harnessType === 'codex') {
      return normalized.includes('codex');
    }

    if (harnessType === 'claude') {
      return normalized.includes('claude');
    }

    return normalized.includes(harnessType.toLowerCase());
  } catch {
    return true;
  }
};

const hasLocalProcessBeenGoneLongEnough = (startedAt: Date | null, lastActivityAt: Date | null) => {
  const anchor = lastActivityAt ?? startedAt;
  if (!anchor) {
    return false;
  }

  return Date.now() - anchor.getTime() >= LOCAL_STALE_GRACE_MS;
};

const reconcileTaskRun = async (taskRunId: string) => {
  const run = await prisma.taskRun.findUnique({
    where: { id: taskRunId },
    include: {
      task: {
        include: {
          currentTaskSession: true,
        },
      },
      taskSession: true,
      participants: true,
    },
  });

  if (!run || (run.status !== 'running' && run.status !== 'waiting_for_input')) {
    return false;
  }

  const activeLocalParticipants = run.participants.filter(
    (participant) =>
      participant.executionBackend === 'platform_local'
      && (participant.status === 'running' || participant.status === 'waiting_for_input')
  );

  if (activeLocalParticipants.length === 0) {
    return false;
  }

  const staleParticipants = [];

  for (const participant of activeLocalParticipants) {
    const registryProcess = getRunningProcess(participant.id);
    if (registryProcess?.taskRunId === run.id) {
      continue;
    }

    const metadata = parseMetadata(participant.controlMetadata);
    const pid = typeof metadata.childPid === 'number'
      ? metadata.childPid
      : typeof metadata.childPid === 'string'
      ? Number(metadata.childPid)
      : NaN;
    const pidAlive = Number.isFinite(pid) && await pidLooksLikeHarness(pid, participant.harnessType);

    if (pidAlive) {
      continue;
    }

    if (!hasLocalProcessBeenGoneLongEnough(participant.startedAt, participant.lastActivityAt ?? run.lastActivityAt)) {
      continue;
    }

    staleParticipants.push({
      participant,
      pid: Number.isFinite(pid) ? pid : null,
      reason: Number.isFinite(pid)
        ? 'pid_missing_or_reused'
        : 'pid_unavailable_and_process_unregistered',
    });
  }

  if (staleParticipants.length === 0) {
    return false;
  }

  const now = new Date();
  const finalRunStatus = mapControlStateToTerminalRunStatus(run.controlState);
  const terminalParticipantStatus = getParticipantTerminalStatus(finalRunStatus);
  const staleParticipantIds = new Set(staleParticipants.map(({ participant }) => participant.id));
  const runError =
    finalRunStatus === 'failed'
      ? 'Local harness process disappeared before the run finished'
      : finalRunStatus === 'interrupted'
      ? 'Run was interrupted after the local harness process disappeared'
      : 'Run was stopped after the local harness process disappeared';

  await prisma.$transaction([
    prisma.taskRun.update({
      where: { id: run.id },
      data: {
        status: finalRunStatus,
        activityState: 'stalled',
        completedAt: now,
        error: runError,
        controlMetadata: stringifyMetadata({
          ...parseMetadata(run.controlMetadata),
          liveness: {
            reconciledAt: now.toISOString(),
            staleParticipantIds: [...staleParticipantIds],
            reason: 'local_process_missing',
          },
        }),
      },
    }),
    prisma.task.update({
      where: { id: run.taskId },
      data: {
        status: finalRunStatus,
        completedAt: now,
        error: finalRunStatus === 'failed' ? runError : undefined,
      },
    }),
    ...(run.taskSession
      ? [
          prisma.taskSession.update({
            where: { id: run.taskSession.id },
            data: {
              status: 'failed',
              attentionState: finalRunStatus === 'failed' ? 'stuck' : 'needs_review',
              activeRunId: null,
              summary: run.summary ?? runError,
            },
          }),
        ]
      : []),
    ...run.participants
      .filter((participant) =>
        participant.status === 'pending'
        || participant.status === 'running'
        || participant.status === 'waiting_for_input'
      )
      .map((participant) =>
        prisma.taskRunParticipant.update({
          where: { id: participant.id },
          data: {
            status:
              staleParticipantIds.has(participant.id)
                ? terminalParticipantStatus
                : finalRunStatus === 'failed'
                ? 'failed'
                : terminalParticipantStatus,
            activityState: staleParticipantIds.has(participant.id)
              ? finalRunStatus === 'failed'
                ? 'stalled'
                : 'terminating'
              : 'stalled',
            completedAt: now,
            error: staleParticipantIds.has(participant.id)
              ? runError
              : `Run ended before ${participant.role} could start`,
            controlMetadata: stringifyMetadata({
              ...parseMetadata(participant.controlMetadata),
              liveness: {
                reconciledAt: now.toISOString(),
                staleRunDetected: staleParticipantIds.has(participant.id),
              },
            }),
          },
        })
      ),
  ]);

  for (const { participant, pid, reason } of staleParticipants) {
    await publishTaskRunEvent({
      taskId: run.taskId,
      taskRunId: run.id,
      participantId: participant.id,
      participant: {
        gatewayId: participant.gatewayId ?? null,
        gatewayName: participant.gatewayNameSnapshot,
        executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw',
        harnessType: participant.harnessType,
        harnessLabel: participant.harnessNameSnapshot ?? null,
        role: participant.role,
        agentId: participant.agentId ?? null,
        agentName: participant.agentNameSnapshot ?? null,
      },
      eventType: finalRunStatus === 'failed' ? 'participant_failed' : finalRunStatus === 'stopped' ? 'participant_stopped' : 'participant_interrupted',
      content:
        finalRunStatus === 'failed'
          ? `${participant.role} 的本地 harness 进程已消失，平台已将该运行标记为失败。`
          : finalRunStatus === 'stopped'
          ? `${participant.role} 的本地 harness 进程已消失，平台按停止请求收口该运行。`
          : `${participant.role} 的本地 harness 进程已消失，平台按中断请求收口该运行。`,
      metadata: {
        staleReason: reason,
        childPid: pid,
      },
    });
  }

  await publishTaskRunEvent({
    taskId: run.taskId,
    taskRunId: run.id,
    eventType:
      finalRunStatus === 'failed'
        ? 'run_failed'
        : finalRunStatus === 'stopped'
        ? 'run_stopped'
        : 'run_interrupted',
    content:
      finalRunStatus === 'failed'
        ? '平台检测到本地 harness 进程已消失，已自动将该 run 标记为失败。'
        : finalRunStatus === 'stopped'
        ? '平台检测到本地 harness 进程已消失，已按停止请求收口该 run。'
        : '平台检测到本地 harness 进程已消失，已按中断请求收口该 run。',
    metadata: {
      staleParticipantIds: [...staleParticipantIds],
      reconciledAt: now.toISOString(),
    },
  });

  return true;
};

export const reconcileTaskRunLiveness = async (taskId: string) => {
  const activeRuns = await prisma.taskRun.findMany({
    where: {
      taskId,
      status: {
        in: ['running', 'waiting_for_input'],
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
    },
  });

  let changed = false;
  for (const run of activeRuns) {
    changed = (await reconcileTaskRun(run.id)) || changed;
  }

  return changed;
};
