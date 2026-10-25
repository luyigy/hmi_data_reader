import { graphRoomMemberTaskIds, graphRoomParticipantMatches } from './task-graph/conversation-reset-stop';
import { promises as fs } from 'node:fs';
import { requestRunControl } from '@/lib/acpx/process-registry';
import type { RunControlAction } from '@/lib/acpx/types';
import { parseAcpxMetadata } from '@/lib/acpx/session-tracking';
import {
  getLiveRoomRunningProcess,
  interruptLiveRoomRunningProcess,
} from '@/lib/live-room-process-registry';
import {
  getLiveRoomParticipantContinuationKey,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';
import { finishPendingTaskRunInteractionRequests } from '@/lib/acpx/interactions';

export const parsePersistedChildPid = (controlMetadata: string | null) => {
  try {
    const pid = Number(JSON.parse(controlMetadata || '{}').childPid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const harnessCommandMatches = (command: string, harnessType: string) => {
  const normalized = command.toLowerCase();
  if (harnessType === 'codex') return normalized.includes('codex');
  if (harnessType === 'claude') return normalized.includes('claude');
  if (harnessType === 'gemini-cli') return normalized.includes('gemini');
  if (harnessType === 'antigravity') return normalized.includes('agy');
  return normalized.includes(harnessType.toLowerCase());
};

export const getPersistedHarnessPid = async (controlMetadata: string | null, harnessType: string) => {
  const pid = parsePersistedChildPid(controlMetadata);
  if (!pid) return null;
  try {
    const command = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
    return harnessCommandMatches(command, harnessType) ? pid : null;
  } catch {
    return null;
  }
};

export const interruptPersistedHarness = async (
  controlMetadata: string | null,
  harnessType: string,
  signal: NodeJS.Signals
) => {
  const pid = await getPersistedHarnessPid(controlMetadata, harnessType);
  if (!pid) return false;

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

export const interruptLiveRoomMemberReplies = async ({
  roomId,
  memberId,
  controlAction = 'interrupt_now',
}: {
  roomId: string;
  memberId: string;
  controlAction?: RunControlAction;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });

  if (!room) {
    throw new Error('Live room not found');
  }

  const member = await prisma.liveRoomMember.findFirst({
    where: {
      id: memberId,
      roomId,
    },
    select: {
      id: true,
      displayName: true,
      backend: true,
      canReply: true,
      role: true, harnessType: true, runtimeAgentId: true, gatewayId: true,
    },
  });

  if (!member) {
    throw new Error('Live room member not found');
  }

  if (!member.canReply) {
    throw new Error('Selected member cannot reply');
  }

  const runningDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'running',
    },
    orderBy: {
      attemptedAt: 'desc',
    },
  });

  const queuedDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'pending',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const graphTaskIds = room.sourceTask ? await graphRoomMemberTaskIds(room.sourceTask.id) : [];
  const runningRuns = room.sourceTask
    ? await prisma.taskRun.findMany({
        where: { taskId: { in: [room.sourceTask.id, ...graphTaskIds] }, status: { in: ['pending', 'running', 'waiting_for_input'] } },
        include: { participants: { where: { status: { in: ['pending', 'running', 'waiting_for_input'] } } } },
      })
    : [];
  const continuationKey = getLiveRoomParticipantContinuationKey(member.id);
  const runningParticipants = runningRuns.flatMap((run) => run.participants
    .filter((participant) => parseAcpxMetadata(participant.controlMetadata).continuationKey === continuationKey || graphTaskIds.includes(run.taskId) && graphRoomParticipantMatches(participant, member))
    .map((participant) => ({
      runId: run.id,
      participantId: participant.id,
      controlMetadata: participant.controlMetadata,
      harnessType: participant.harnessType,
    })));
  const staleParticipants: Array<{ runId: string; participantId: string }> = [];
  let interruptedParticipantCount = 0;
  let interruptedRegistryProcess = false;

  await Promise.all(runningParticipants.map(({ participantId }) =>
    finishPendingTaskRunInteractionRequests({ participantId, status: 'cancelled' })));
  for (const participant of runningParticipants) {
    const interruption = requestRunControl(
      participant.runId,
      participant.participantId,
      controlAction
    );
    if (!interruption.applied) {
      const signal = controlAction === 'stop_run' ? 'SIGKILL' : 'SIGINT';
      const killed = await interruptPersistedHarness(
        participant.controlMetadata,
        participant.harnessType,
        signal
      );
      if (killed) {
        staleParticipants.push(participant);
        interruptedParticipantCount += 1;
      }
    } else {
      interruptedParticipantCount += 1;
    }
  }

  if (runningParticipants.length === 0 && room.sourceTask) {
    const recentParticipants = await prisma.taskRunParticipant.findMany({
      where: {
        executionBackend: 'platform_local',
        taskRun: { taskId: room.sourceTask.id },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    for (const participant of recentParticipants) {
      if (parseAcpxMetadata(participant.controlMetadata).continuationKey !== continuationKey) continue;
      const signal = controlAction === 'stop_run' ? 'SIGKILL' : 'SIGINT';
      if (await interruptPersistedHarness(participant.controlMetadata, participant.harnessType, signal)) {
        interruptedParticipantCount += 1;
      }
    }
  }

  if (runningParticipants.length === 0) {
    const runningRegistry = getLiveRoomRunningProcess(member.id);
    if (runningRegistry) {
      interruptedRegistryProcess = interruptLiveRoomRunningProcess(member.id, 'SIGTERM').applied;
    }
  }

  const interruptedAt = new Date();

  if (staleParticipants.length > 0) {
    await prisma.taskRunParticipant.updateMany({
      where: { id: { in: staleParticipants.map((participant) => participant.participantId) } },
      data: {
        status: 'interrupted',
        error: 'Stale process cleared by session reset',
        completedAt: interruptedAt,
      },
    });
    await prisma.taskRun.updateMany({
      where: { id: { in: staleParticipants.map((participant) => participant.runId) } },
      data: {
        status: 'interrupted',
        error: 'Stale process cleared by session reset',
        completedAt: interruptedAt,
      },
    });
  }

  if (runningDeliveries.length > 0 && (interruptedParticipantCount > 0 || interruptedRegistryProcess)) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: runningDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Interrupted by user',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  if (queuedDeliveries.length > 0) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: queuedDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: 'Cancelled by user before execution',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  const latestSession = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (latestSession) {
    await prisma.liveRoomMemberSession.update({
      where: { id: latestSession.id },
      data: {
        status: 'online',
        lastError: runningDeliveries.length > 0 ? 'Interrupted by user' : 'Cancelled by user before execution',
      },
    });
  }

  await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: {
      presenceStatus: 'online',
    },
  });

  const interruptedRunningCount = Math.max(interruptedParticipantCount, interruptedRegistryProcess ? 1 : 0);
  const failedRunningCount = Math.max(
    0,
    Math.max(runningDeliveries.length, runningParticipants.length) - interruptedRunningCount
  );
  if (interruptedRunningCount > 0 || queuedDeliveries.length > 0) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：已中断 ${member.displayName} 的回复${queuedDeliveries.length > 0 ? `，并清理 ${queuedDeliveries.length} 条排队消息` : ''}。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: member.id,
        extras: {
          systemEvent: 'member_reply_interrupted',
          interruptedDeliveryIds: runningDeliveries.map((delivery) => delivery.id),
          supersededDeliveryIds: queuedDeliveries.map((delivery) => delivery.id),
        },
      }),
    });
  }

  return {
    interruptedRunningCount,
    failedRunningCount,
    cancelledQueuedCount: queuedDeliveries.length,
  };
};
