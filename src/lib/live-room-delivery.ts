import { prisma } from '@/lib/prisma';
import {
  enqueueLiveRoomMemberExecution,
  hasLiveRoomMemberExecution,
} from '@/lib/live-room-process-registry';
import {
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { shouldRunRoleQueue } from '@/lib/live-room-scheduling';
import {
  parseLiveRoomWorkflowCommand,
  runLiveRoomPlan,
  runLiveRoomWorkflow,
} from '@/lib/live-room-workflows';
import {
  ensureMemberSession,
  getPrimaryReplyTarget,
  getTargetMemberIdsForMessage,
} from '@/lib/live-room-delivery-routing';
import { processLiveRoomDelivery } from '@/lib/live-room-delivery-processing';
import {
  claimLiveRoomHandoff,
  ensureLiveRoomHandoffRoot,
} from '@/lib/live-room-handoff';

const ALL_REPLY_STAGGER_MS = 750;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { interruptLiveRoomMemberReplies } from '@/lib/live-room-interrupt';

const enqueuePreparedLiveRoomDelivery = async ({
  deliveryId,
  roomId,
  roomMessageId,
  targetMember,
  chainDepth,
  relayOrigin,
  waitForCompletion,
}: {
  deliveryId: string;
  roomId: string;
  roomMessageId: string;
  targetMember: { id: string; displayName: string; backend: string | null };
  chainDepth: number;
  relayOrigin: { feishuBindingId?: string; feishuChatId?: string };
  waitForCompletion: boolean;
}) => {
  const queued = hasLiveRoomMemberExecution(targetMember.id);

  if (targetMember.backend === 'remote_ssh') {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        id: { not: deliveryId },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: `Superseded by newer live room delivery ${deliveryId}`,
        acknowledgedAt: new Date(),
      },
    });
  }

  if (queued) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：已收到这条消息，${targetMember.displayName} 当前正在处理上一条，将随后处理。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: targetMember.id,
        extras: {
          ...relayOrigin,
          systemEvent: 'member_reply_queued',
          deliveryId,
        },
      }),
    });
  }

  await enqueueLiveRoomMemberExecution(targetMember.id, async () => {
    const handoff = await processLiveRoomDelivery({
      deliveryId,
      roomId,
      roomMessageId,
      targetMemberId: targetMember.id,
      chainDepth,
    });
    if (handoff) {
      setImmediate(() => {
        void dispatchLiveRoomHandoff(handoff).catch((error) => {
          console.error('Failed to dispatch live room handoff:', error);
        });
      });
    }
  }, waitForCompletion);
};

const dispatchLiveRoomHandoff = async (handoff: NonNullable<
  Awaited<ReturnType<typeof processLiveRoomDelivery>>
>) => {
  const claim = await claimLiveRoomHandoff(handoff);
  if (claim.status === 'duplicate') return;

  if (claim.status !== 'accepted') {
    const content = claim.status === 'rejected_disabled'
      ? '系统提示：当前房间已关闭自动 handoff，本次不接力。'
      : claim.status === 'rejected_budget_exhausted'
      ? '系统提示：当前根消息的 handoff 预算已用尽，本次不接力。'
      : '系统提示：handoff 根消息状态无效，本次不接力。';
    await postLiveRoomMessage({
      roomId: handoff.roomId,
      content,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: {
          ...handoff.relayOrigin,
          systemEvent: claim.status,
          assistantMessageId: handoff.assistantMessageId,
        },
      }),
    });
    return;
  }

  if (!claim.delivery || claim.delivery.deliveryStatus !== 'pending') {
    await postLiveRoomMessage({
      roomId: handoff.roomId,
      content: `系统提示：handoff 已计入预算，但目标成员不可用：${claim.delivery?.fallbackReason || 'member missing'}。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: handoff.targetMemberId,
        extras: {
          ...handoff.relayOrigin,
          systemEvent: 'handoff_target_unavailable',
          assistantMessageId: handoff.assistantMessageId,
        },
      }),
    });
    return;
  }

  const targetMember = await prisma.liveRoomMember.findFirst({
    where: {
      id: handoff.targetMemberId,
      roomId: handoff.roomId,
    },
    select: {
      id: true,
      displayName: true,
      backend: true,
    },
  });
  if (!targetMember) return;

  await postLiveRoomMessage({
    roomId: handoff.roomId,
    content: `系统提示：已接受 ${handoff.sourceMemberName} → ${targetMember.displayName} 的异步 handoff。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      targetMemberId: targetMember.id,
      extras: {
        ...handoff.relayOrigin,
        systemEvent: 'handoff_accepted',
        assistantMessageId: handoff.assistantMessageId,
        deliveryId: claim.delivery.id,
      },
    }),
  });

  await enqueuePreparedLiveRoomDelivery({
    deliveryId: claim.delivery.id,
    roomId: handoff.roomId,
    roomMessageId: handoff.assistantMessageId,
    targetMember,
    chainDepth: handoff.chainDepth + 1,
    relayOrigin: handoff.relayOrigin,
    waitForCompletion: false,
  });
};

export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
  forceTargetMember = false,
  waitForCompletion = true,
  allowHandoff = true,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
  forceTargetMember?: boolean;
  waitForCompletion?: boolean;
  allowHandoff?: boolean;
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
  const relayOrigin = {
    feishuBindingId: typeof sourceMetadata?.feishuBindingId === 'string'
      ? sourceMetadata.feishuBindingId
      : undefined,
    feishuChatId: typeof sourceMetadata?.feishuChatId === 'string'
      ? sourceMetadata.feishuChatId
      : undefined,
  };
  const targetMember = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId: targetMemberId,
    preferRequestedTarget: forceTargetMember || Boolean(targetMemberId),
  });

  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);
  const handoffRoot = allowHandoff
    ? await ensureLiveRoomHandoffRoot({
        messageId: sourceMessage.id,
        handoffLimit: room.handoffLimit,
      })
    : null;
  const delivery = await prisma.liveRoomDelivery.create({
    data: {
      roomMessageId,
      targetMemberId: targetMember.id,
      sessionId: session.id,
      handoffRootMessageId: handoffRoot?.id || null,
      deliveryStatus: 'pending',
    },
  });

  await enqueuePreparedLiveRoomDelivery({
    deliveryId: delivery.id,
    roomId: room.id,
    roomMessageId,
    targetMember,
    chainDepth,
    relayOrigin,
    waitForCompletion,
  });
};

export const triggerLiveRoomMessageReplies = async ({
  roomId,
  roomMessageId,
  requestedTargetMemberId,
  waitForCompletion = true,
  allowHandoff = true,
}: {
  roomId: string;
  roomMessageId: string;
  requestedTargetMemberId?: string | null;
  waitForCompletion?: boolean;
  allowHandoff?: boolean;
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

  const planHandled = !requestedTargetMemberId && await runLiveRoomPlan({
    roomId,
    sourceMessageId: roomMessageId,
    content: sourceMessage.content,
  });
  if (planHandled) return;

  const workflow = parseLiveRoomWorkflowCommand(sourceMessage.content);
  if (
    workflow
    && !requestedTargetMemberId
    && shouldRunRoleQueue(room.mode, sourceMessage.content)
  ) {
    await runLiveRoomWorkflow({
      roomId,
      sourceMessageId: roomMessageId,
      name: workflow.name,
      level: workflow.level,
      task: workflow.task,
    });
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const relayOrigin = {
    feishuBindingId: sourceMetadata?.feishuBindingId,
    feishuChatId: sourceMetadata?.feishuChatId,
  };
  const targetMemberIds = getTargetMemberIdsForMessage({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
    sourceContent: sourceMessage.content,
  });

  if (targetMemberIds.length === 0) {
    return;
  }

  const isMentionAll = sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll;
  const isRoleQueue =
    !isMentionAll
    && targetMemberIds.length > 1
    && shouldRunRoleQueue(room.mode, sourceMessage.content);
  if (isMentionAll) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：$all 已发送，当前共有 ${targetMemberIds.length} 个可回复成员会按顺序回应。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        mentionedAll: true,
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: {
          ...relayOrigin,
          systemEvent: 'mention_all_dispatch_started',
        },
      }),
    });
  } else if (isRoleQueue) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：${room.mode} role queue 已启动：${targetMemberIds
        .map((memberId) => room.members.find((member) => member.id === memberId)?.displayName)
        .filter(Boolean)
        .join(' → ')}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: { ...relayOrigin, systemEvent: 'role_queue_started' },
      }),
    });
  }

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
      forceTargetMember: isMentionAll || isRoleQueue,
      waitForCompletion,
      allowHandoff: allowHandoff && !isMentionAll && !isRoleQueue,
    });
  }
};
