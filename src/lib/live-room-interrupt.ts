import { requestRunControl } from '@/lib/acpx/process-registry';
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

export const interruptLiveRoomMemberReplies = async ({
  roomId,
  memberId,
}: {
  roomId: string;
  memberId: string;
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

  const runningRuns = room.sourceTask
    ? await prisma.taskRun.findMany({
        where: { taskId: room.sourceTask.id, status: 'running' },
        include: { participants: { where: { status: 'running' } } },
      })
    : [];
  const continuationKey = getLiveRoomParticipantContinuationKey(member.id);
  const runningParticipants = runningRuns.flatMap((run) => run.participants
    .filter((participant) => parseAcpxMetadata(participant.controlMetadata).continuationKey === continuationKey)
    .map((participant) => ({ runId: run.id, participantId: participant.id })));
  const staleParticipants: Array<{ runId: string; participantId: string }> = [];
  let interruptedRegistryProcess = false;

  for (const participant of runningParticipants) {
    const interruption = requestRunControl(
      participant.runId,
      participant.participantId,
      'interrupt_now'
    );
    if (!interruption.applied) {
      staleParticipants.push(participant);
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

  if (runningDeliveries.length > 0) {
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

  const interruptedRunningCount = Math.max(
    runningDeliveries.length,
    runningParticipants.length,
    interruptedRegistryProcess ? 1 : 0
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
    cancelledQueuedCount: queuedDeliveries.length,
  };
};
