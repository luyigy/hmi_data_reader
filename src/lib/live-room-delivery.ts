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

const ALL_REPLY_STAGGER_MS = 750;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { interruptLiveRoomMemberReplies } from '@/lib/live-room-interrupt';
export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
  forceTargetMember = false,
  waitForCompletion = true,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
  forceTargetMember?: boolean;
  waitForCompletion?: boolean;
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
    feishuBindingId: sourceMetadata?.feishuBindingId,
    feishuChatId: sourceMetadata?.feishuChatId,
  };
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

  const queued = hasLiveRoomMemberExecution(targetMember.id);

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
  }

  if (queued) {
    await postLiveRoomMessage({
      roomId: room.id,
      content: `系统提示：已收到这条消息，${targetMember.displayName} 当前正在处理上一条，将随后处理。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: targetMember.id,
        extras: {
          ...relayOrigin,
          systemEvent: 'member_reply_queued',
          deliveryId: delivery.id,
        },
      }),
    });
  }

  await enqueueLiveRoomMemberExecution(targetMember.id, async () => {
    await processLiveRoomDelivery({
      deliveryId: delivery.id,
      roomId: room.id,
      roomMessageId,
      targetMemberId: targetMember.id,
      chainDepth,
    });
  }, waitForCompletion);
};

export const triggerLiveRoomMessageReplies = async ({
  roomId,
  roomMessageId,
  requestedTargetMemberId,
  waitForCompletion = true,
}: {
  roomId: string;
  roomMessageId: string;
  requestedTargetMemberId?: string | null;
  waitForCompletion?: boolean;
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
      forceTargetMember: isMentionAll,
      waitForCompletion,
    });
  }
};
