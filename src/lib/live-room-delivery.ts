import { prisma } from '@/lib/prisma';
import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { findLatestParticipantSession, parseAcpxMetadata } from '@/lib/acpx/session-tracking';
import { requestRunControl } from '@/lib/acpx/process-registry';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '@/lib/acpx/permissions';
import {
  clearLiveRoomRunningProcess,
  enqueueLiveRoomMemberExecution,
  getLiveRoomRunningProcess,
  interruptLiveRoomRunningProcess,
} from '@/lib/live-room-process-registry';
import {
  buildLiveRoomAcpxParticipant,
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  extractRemoteHostIdFromRoleLabel,
  getLiveRoomParticipantContinuationKey,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ALL_REPLY_STAGGER_MS = 750;
const REMOTE_STALE_GRACE_MS = 30 * 1000;
const REMOTE_STALE_AFTER_MS = DEFAULT_TIMEOUT_MS + REMOTE_STALE_GRACE_MS;
const SSH_WARNING_PATTERNS = [
  /^Warning: Permanently added .*known hosts\.\s*$/gim,
];

type DeliveryRoomMember = {
  id: string;
  canReply: boolean;
  displayName: string;
  backend: string | null;
  harnessType: string | null;
  runtimeAgentId: string | null;
  gatewayId: string | null;
  roleLabel?: string | null;
  gateway?: { name: string } | null;
  agentRecord?: { runtimeAgentId: string | null } | null;
};

type DeliveryRoom = {
  id: string;
  title: string;
  currentTopic: string | null;
  currentSpeakerMemberId: string | null;
  members: DeliveryRoomMember[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeLiveRoomExecutionError = (message: string) => {
  let normalized = message;

  for (const pattern of SSH_WARNING_PATTERNS) {
    normalized = normalized.replace(pattern, '').trim();
  }

  return normalized || 'Live room execution failed';
};

const getSessionKey = (roomId: string, memberId: string) => `live-room:${roomId}:member:${memberId}`;

const getReplyEligibleMembers = ({
  room,
  sourceSenderMemberId,
}: {
  room: DeliveryRoom | null;
  sourceSenderMemberId?: string | null;
}) => (room?.members || []).filter((member: DeliveryRoomMember) => member.canReply && member.id !== sourceSenderMemberId);

const getPrimaryReplyTarget = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
  preferRequestedTarget = false,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
  preferRequestedTarget?: boolean;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  const baseCandidates = [
    sourceMetadata?.deliveryIntent === 'handoff' ? sourceMetadata.handoffToMemberId : null,
    sourceMetadata?.primaryTargetMemberId || null,
    sourceMetadata?.mentionedMemberIds?.[0] || null,
    room.currentSpeakerMemberId || null,
  ].filter(Boolean) as string[];

  const candidates = preferRequestedTarget
    ? [requestedTargetMemberId || null, ...baseCandidates]
    : [...baseCandidates, requestedTargetMemberId || null];

  for (const candidate of candidates) {
    const found = eligibleMembers.find((member: DeliveryRoomMember) => member.id === candidate);
    if (found) {
      return found;
    }
  }

  return eligibleMembers[0] || null;
};

const getTargetMemberIdsForMessage = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  if (sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll) {
    const expectedIds = (sourceMetadata.expectedResponderMemberIds || []).filter(Boolean) as string[];
    const targets = (expectedIds.length > 0 ? expectedIds : eligibleMembers.map((member: DeliveryRoomMember) => member.id))
      .filter((memberId: string, index: number, list: string[]) => list.indexOf(memberId) === index)
      .filter((memberId: string) => eligibleMembers.some((member: DeliveryRoomMember) => member.id === memberId));

    return targets;
  }

  const primaryTarget = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
  });

  return primaryTarget ? [primaryTarget.id] : [];
};

const ensureMemberSession = async (roomId: string, member: {
  id: string;
  backend: string | null;
  harnessType: string | null;
}) => {
  const existing = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.liveRoomMemberSession.create({
    data: {
      roomId,
      memberId: member.id,
      backend: member.backend || 'platform_local',
      sessionKey: getSessionKey(roomId, member.id),
      status: 'online',
      supportsStreaming: member.backend === 'platform_local',
      supportsAppendMessage: true,
      supportsInterrupt: member.harnessType === 'codex' || member.backend === 'remote_ssh',
    },
  });
};


const executeLiveRoomReplyViaAcpx = async ({
  room,
  sourceMessage,
  targetMember,
  session,
}: {
  room: DeliveryRoom & {
    sourceTask?: {
      id: string;
      name: string;
      description?: string | null;
      workingDirectory?: string | null;
      acpxPermissionConfig?: string | null;
      currentTaskSession?: {
        id: string;
      } | null;
    } | null;
  };
  sourceMessage: {
    id: string;
    content: string;
    senderMember?: {
      id: string;
      displayName: string;
      memberType: string;
    } | null;
  };
  targetMember: DeliveryRoomMember;
  session: {
    id: string;
    threadId: string | null;
  };
}) => {
  const sourceTask = await syncLiveRoomSourceTask(room.id);
  if (!sourceTask) {
    throw new Error('Live room source ACPX task is unavailable');
  }

  const participant = buildLiveRoomAcpxParticipant({
    id: targetMember.id,
    displayName: targetMember.displayName,
    backend: targetMember.backend,
    harnessType: targetMember.harnessType,
    gatewayId: targetMember.backend === 'remote_ssh'
      ? extractRemoteHostIdFromRoleLabel(targetMember.roleLabel) || targetMember.gatewayId
      : targetMember.gatewayId,
    gatewayName: targetMember.gateway?.name || null,
    runtimeAgentId: targetMember.runtimeAgentId || targetMember.agentRecord?.runtimeAgentId || null,
  });

  const latestSession = await findLatestParticipantSession(sourceTask.id, participant);
  const taskRoom = await ensureTaskChatRoom(sourceTask.id, sourceTask.name);
  const shouldInjectLatestInstruction = sourceMessage.senderMember?.memberType !== 'user';

  if (shouldInjectLatestInstruction) {
    await postTaskRoomMessage({
      roomId: taskRoom.id,
      content: sourceMessage.content,
      userId: 'task-room-user',
      userName: sourceMessage.senderMember?.displayName || '用户',
      targetType: 'participant',
      targetParticipantKey: getTaskRoomParticipantTargetKey(participant),
      targetParticipantLabel: getTaskRoomParticipantTargetLabel(participant),
    });
  }

  await prisma.task.update({
    where: { id: sourceTask.id },
    data: {
      status: 'running',
      startedAt: new Date(),
      completedAt: null,
      error: null,
    },
  });

  const permissionConfig = (() => {
    const parsed = parseAcpxMetadata(sourceTask.acpxPermissionConfig);
    return (Object.keys(parsed).length > 0 ? parsed : DEFAULT_ACPX_PERMISSION_CONFIG) as AcpxPermissionConfig;
  })();

  const acpxResult = await executeAcpxTaskRun({
    taskId: sourceTask.id,
    taskSessionId: sourceTask.currentTaskSession?.id || undefined,
    taskName: sourceTask.name,
    taskDescription: sourceTask.description || undefined,
    orchestrationMode: 'single',
    participants: [{
      ...participant,
      resumeThreadId: latestSession?.continuationThreadId || undefined,
      continuationMessage: latestSession?.continuationThreadId ? sourceMessage.content : undefined,
    }],
    workingDirectory: sourceTask.workingDirectory || process.cwd(),
    permissionConfig,
  });

  const participantResult = acpxResult.participants[0];
  const finalStatus =
    acpxResult.status === 'completed'
      ? 'completed'
      : acpxResult.status === 'interrupted'
      ? 'running'
      : acpxResult.status === 'stopped'
      ? 'failed'
      : 'failed';

  await prisma.task.update({
    where: { id: sourceTask.id },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      result: JSON.stringify({
        executionMode: 'acpx',
        source: 'live_room',
        liveRoomId: room.id,
        taskRunId: acpxResult.taskRunId,
        summary: acpxResult.summary,
        participants: acpxResult.participants,
      }),
      error:
        acpxResult.status === 'failed'
          ? participantResult?.error || 'Live room ACPX execution failed'
          : null,
    },
  });

  if (acpxResult.status === 'interrupted') {
    throw new Error('Interrupted by user');
  }

  if (acpxResult.status === 'stopped') {
    throw new Error('Stopped by user');
  }

  if (acpxResult.status === 'failed') {
    throw new Error(participantResult?.error || 'Live room ACPX execution failed');
  }

  const refreshedParticipantSession = await findLatestParticipantSession(sourceTask.id, participant);

  return {
    output: participantResult?.summary || acpxResult.summary || `${targetMember.displayName} completed`,
    threadId: refreshedParticipantSession?.continuationThreadId || session.threadId,
    remoteTiming: null,
  };
};

const markRemoteDeliverySuperseded = async (deliveryId: string, reason: string) => {
  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      targetMember: {
        select: {
          id: true,
        },
      },
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!delivery || (delivery.deliveryStatus !== 'pending' && delivery.deliveryStatus !== 'running')) {
    return false;
  }

  await prisma.liveRoomDelivery.update({
    where: { id: deliveryId },
    data: {
      deliveryStatus: 'superseded',
      fallbackReason: reason,
      acknowledgedAt: new Date(),
    },
  });

  if (delivery.sessionId) {
    await prisma.liveRoomMemberSession.update({
      where: { id: delivery.sessionId },
      data: {
        status: 'online',
        lastError: reason,
      },
    }).catch(() => undefined);
  }

  await prisma.liveRoomMember.update({
    where: { id: delivery.targetMemberId },
    data: {
      presenceStatus: 'online',
    },
  }).catch(() => undefined);

  return true;
};

const failStaleRemoteDeliveries = async (memberId: string) => {
  const staleBefore = new Date(Date.now() - REMOTE_STALE_AFTER_MS);
  const registryEntry = getLiveRoomRunningProcess(memberId);

  if (registryEntry && Date.now() - registryEntry.startedAt >= REMOTE_STALE_AFTER_MS) {
    interruptLiveRoomRunningProcess(memberId, 'SIGTERM');
  }

  const staleDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: memberId,
      deliveryStatus: {
        in: ['pending', 'running'],
      },
      attemptedAt: {
        lt: staleBefore,
      },
    },
    include: {
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  for (const delivery of staleDeliveries) {
    if (registryEntry?.deliveryId === delivery.id) {
      continue;
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Remote SSH live room delivery became stale before completion',
        acknowledgedAt: new Date(),
      },
    });

    if (delivery.sessionId) {
      await prisma.liveRoomMemberSession.update({
        where: { id: delivery.sessionId },
        data: {
          status: 'online',
          lastError: 'Remote SSH live room delivery became stale before completion',
        },
      }).catch(() => undefined);
    }
  }

  if (staleDeliveries.length > 0) {
    await prisma.liveRoomMember.update({
      where: { id: memberId },
      data: {
        presenceStatus: 'online',
      },
    }).catch(() => undefined);
  }
};

const processLiveRoomDelivery = async ({
  deliveryId,
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth,
  allowChainedMentions,
}: {
  deliveryId: string;
  roomId: string;
  roomMessageId: string;
  targetMemberId: string;
  chainDepth: number;
  allowChainedMentions: boolean;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      sourceTask: true,
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
    include: {
      senderMember: true,
    },
  });

  if (!sourceMessage) {
    return;
  }

  const targetMember = room.members.find((member) => member.id === targetMemberId);
  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery || delivery.deliveryStatus !== 'pending') {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);

  if (targetMember.backend === 'remote_ssh') {
    await failStaleRemoteDeliveries(targetMember.id);

    const newerPendingDelivery = await prisma.liveRoomDelivery.findFirst({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        createdAt: {
          gt: delivery.createdAt,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
      },
    });

    if (newerPendingDelivery) {
      await markRemoteDeliverySuperseded(
        delivery.id,
        `Superseded by newer live room delivery ${newerPendingDelivery.id}`
      );
      return;
    }
  }

  await prisma.liveRoomDelivery.update({
    where: { id: delivery.id },
    data: {
      sessionId: session.id,
      deliveryStatus: 'running',
      attemptedAt: new Date(),
      fallbackReason: null,
    },
  });

  await prisma.liveRoomMember.update({
    where: { id: targetMember.id },
    data: {
      presenceStatus: 'busy',
    },
  });

  try {
    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'busy',
        lastHeartbeatAt: new Date(),
        lastError: 'progress:acpx participant running',
      },
    }).catch(() => undefined);

    const acpxResult = await executeLiveRoomReplyViaAcpx({
      room,
      sourceMessage: {
        id: sourceMessage.id,
        content: sourceMessage.content,
        senderMember: sourceMessage.senderMember
          ? {
              id: sourceMessage.senderMember.id,
              displayName: sourceMessage.senderMember.displayName,
              memberType: sourceMessage.senderMember.memberType,
            }
          : null,
      },
      targetMember,
      session: {
        id: session.id,
        threadId: session.threadId,
      },
    });

    const output = acpxResult.output;
    const threadId = acpxResult.threadId;
    const remoteTiming = acpxResult.remoteTiming;

    if (threadId !== session.threadId || session.status !== 'online') {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          threadId,
          status: 'online',
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    } else {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'delivered',
        acknowledgedAt: new Date(),
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'online',
      },
    });

    const replyMessage = await postLiveRoomMessage({
      roomId: room.id,
      senderMemberId: targetMember.id,
      content: output,
      messageType: 'assistant',
      replyToMessageId: sourceMessage.id,
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'assistant',
        replyToMessageId: sourceMessage.id,
        mentionedMemberIds: detectMentionedLiveRoomMembers({
          content: output,
          members: room.members,
          senderMemberId: targetMember.id,
        }),
        mentionedAll: detectLiveRoomMentionAll(output),
        expectedResponderMemberIds: detectLiveRoomMentionAll(output)
          ? room.members.filter((member) => member.canReply && member.id !== targetMember.id).map((member) => member.id)
          : [],
        extras: {
          deliveryId: delivery.id,
          backend: targetMember.backend,
          harnessType: targetMember.harnessType,
          chainDepth,
          remoteTiming,
        },
      }),
    });

    if (allowChainedMentions && chainDepth < 2) {
      const replyMetadata = parseLiveRoomMessageMetadata(JSON.stringify(replyMessage.metadata || null));
      const nextTargetMemberIds = getTargetMemberIdsForMessage({
        room,
        sourceMessageSenderMemberId: targetMember.id,
        sourceMetadata: replyMetadata,
        requestedTargetMemberId: null,
      });

      for (const nextTargetMemberId of nextTargetMemberIds) {
        await triggerLiveRoomAgentReply({
          roomId: room.id,
          roomMessageId: replyMessage.id,
          targetMemberId: nextTargetMemberId,
          chainDepth: chainDepth + 1,
          allowChainedMentions: !(replyMetadata?.deliveryIntent === 'mention_all' || replyMetadata?.mentionedAll),
        });
      }
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Live room delivery failed';
    const message = normalizeLiveRoomExecutionError(rawMessage);

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: message,
        acknowledgedAt: new Date(),
      },
    });

    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'online',
        lastError: message,
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'idle',
      },
    });

    if (message !== 'Interrupted by user') {
      await postLiveRoomMessage({
        roomId,
        content:
          message === 'Stopped by user'
            ? `系统提示：${targetMember.displayName} 当前回复已被停止。`
            : `系统提示：${targetMember.displayName} 本次回复失败：${message}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          targetMemberId: targetMember.id,
          extras: {
            error: message,
          },
        }),
      });
    }
  } finally {
    if (targetMember.backend === 'remote_ssh') {
      clearLiveRoomRunningProcess(targetMember.id, delivery.id);
    }
  }
};

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

  if (member.backend !== 'remote_ssh') {
    throw new Error('Only remote SSH live room replies can be interrupted in Phase 1');
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

  const activeRun = room.sourceTask?.currentTaskSession?.activeRunId
    ? await prisma.taskRun.findUnique({
        where: { id: room.sourceTask.currentTaskSession.activeRunId },
        include: {
          participants: true,
        },
      })
    : null;
  const runningParticipant = activeRun?.participants.find((participant) => {
    const metadata = parseAcpxMetadata(participant.controlMetadata);
    return metadata.continuationKey === getLiveRoomParticipantContinuationKey(member.id);
  }) || null;

  if (activeRun && runningParticipant) {
    requestRunControl(activeRun.id, runningParticipant.id, 'interrupt_now');
  } else {
    const runningRegistry = getLiveRoomRunningProcess(member.id);
    if (runningRegistry) {
      interruptLiveRoomRunningProcess(member.id, 'SIGTERM');
    }
  }

  const interruptedAt = new Date();

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

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：已中断 ${member.displayName} 的远端回复${queuedDeliveries.length > 0 ? `，并清理 ${queuedDeliveries.length} 条排队消息` : ''}。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      targetMemberId: member.id,
      extras: {
        systemEvent: 'remote_reply_interrupted',
        interruptedDeliveryIds: runningDeliveries.map((delivery) => delivery.id),
        supersededDeliveryIds: queuedDeliveries.map((delivery) => delivery.id),
      },
    }),
  });

  return {
    interruptedRunningCount: runningDeliveries.length,
    cancelledQueuedCount: queuedDeliveries.length,
  };
};

export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
  allowChainedMentions = true,
  forceTargetMember = false,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
  allowChainedMentions?: boolean;
  forceTargetMember?: boolean;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      sourceTask: true,
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
    include: {
      senderMember: true,
    },
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const targetMember = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId: targetMemberId,
    preferRequestedTarget: forceTargetMember,
  });

  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);
  const delivery = await prisma.liveRoomDelivery.create({
    data: {
      roomMessageId,
      targetMemberId: targetMember.id,
      sessionId: session.id,
      deliveryStatus: 'pending',
    },
  });

  if (targetMember.backend === 'remote_ssh') {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        id: {
          not: delivery.id,
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: `Superseded by newer live room delivery ${delivery.id}`,
        acknowledgedAt: new Date(),
      },
    });

    await enqueueLiveRoomMemberExecution(targetMember.id, async () => {
      await processLiveRoomDelivery({
        deliveryId: delivery.id,
        roomId: room.id,
        roomMessageId,
        targetMemberId: targetMember.id,
        chainDepth,
        allowChainedMentions,
      });
    });
    return;
  }

  await processLiveRoomDelivery({
    deliveryId: delivery.id,
    roomId: room.id,
    roomMessageId,
    targetMemberId: targetMember.id,
    chainDepth,
    allowChainedMentions,
  });
};

export const triggerLiveRoomMessageReplies = async ({
  roomId,
  roomMessageId,
  requestedTargetMemberId,
}: {
  roomId: string;
  roomMessageId: string;
  requestedTargetMemberId?: string | null;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const targetMemberIds = getTargetMemberIdsForMessage({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
  });

  if (targetMemberIds.length === 0) {
    return;
  }

  const isMentionAll = sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll;
  if (isMentionAll) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：@all 已发送，当前共有 ${targetMemberIds.length} 个可回复成员会按顺序回应。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        mentionedAll: true,
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: {
          systemEvent: 'mention_all_dispatch_started',
        },
      }),
    });
  }

  const allowChainedMentions = !isMentionAll;
  for (let index = 0; index < targetMemberIds.length; index += 1) {
    const targetMemberId = targetMemberIds[index];
    if (index > 0 && isMentionAll) {
      await sleep(ALL_REPLY_STAGGER_MS);
    }

    await triggerLiveRoomAgentReply({
      roomId,
      roomMessageId,
      targetMemberId,
      chainDepth: 0,
      allowChainedMentions,
      forceTargetMember: isMentionAll,
    });
  }
};
