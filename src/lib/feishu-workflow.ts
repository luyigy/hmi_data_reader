import {
  getBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { handleNewSessionCommand } from '@/lib/feishu-new-session';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';
import {
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';
import { sendFeishuTextMessageAndReturnId } from '@/lib/feishu-api';

export async function runWorkflowInBoundLiveRoom(args: {
  projectId: string;
  jobId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  eventKey: string;
  signal: AbortSignal;
}) {
  args.signal.throwIfAborted();
  let dispatch = await prisma.workflowDispatch.upsert({
    where: {
      projectId_jobId_eventKey: {
        projectId: args.projectId,
        jobId: args.jobId,
        eventKey: args.eventKey,
      },
    },
    create: {
      projectId: args.projectId,
      jobId: args.jobId,
      eventKey: args.eventKey,
    },
    update: {},
  });
  if (dispatch.state === 'reply_queued') return;
  args.signal.throwIfAborted();

  const context: FeishuConversationContext = {
    chatId: args.chatId,
    chatType: args.chatType,
    senderOpenId: 'workflow-watcher',
    messageId: `workflow:${args.eventKey}`,
  };
  const boundRoom = await getBoundLiveRoom(context);
  if (!boundRoom?.sourceTask) throw new Error('bound live room has no source task');

  if (dispatch.state === 'prepared') {
    const resetAlreadyCompleted = await prisma.taskSession.findFirst({
      where: {
        taskId: boundRoom.sourceTask.id,
        metadata: { contains: `"workflowEventKey":${JSON.stringify(args.eventKey)}` },
      },
      select: { id: true },
    });
    if (!resetAlreadyCompleted) {
      const reset = await handleNewSessionCommand({
        command: 'new-session',
        args: [],
        options: {
          all: 'true',
          blank: 'true',
          'workflow-event-key': args.eventKey,
        },
      }, context);
      if (!reset.startsWith('✅')) throw new Error(reset);
    }
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'session_reset' },
    });
  }

  args.signal.throwIfAborted();
  if (dispatch.state === 'session_reset') {
    const feishuMessageId = await sendFeishuTextMessageAndReturnId({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      text: args.prompt,
    });
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'feishu_posted', feishuMessageId },
    });
  }

  args.signal.throwIfAborted();
  const room = await getBoundLiveRoom(context);
  const userMember = room?.members.find((member) => member.memberType === 'user');
  if (!room || !userMember) throw new Error('bound live room has no user member');

  if (dispatch.state === 'feishu_posted') {
    const existingMessage = await prisma.liveRoomMessage.findFirst({
      where: {
        roomId: room.id,
        metadata: { contains: `"eventKey":${JSON.stringify(args.eventKey)}` },
      },
      orderBy: { createdAt: 'desc' },
    });
    const message = existingMessage ?? await postLiveRoomMessage({
        roomId: room.id,
        senderMemberId: userMember.id,
        content: args.prompt,
        messageType: 'user',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'user',
          extras: { source: 'workflow_watcher', eventKey: args.eventKey },
        }),
      });
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'prompt_posted', roomId: room.id, messageId: message.id },
    });
  }

  args.signal.throwIfAborted();
  if (!dispatch.messageId) throw new Error('workflow dispatch has no prompt message');
  const existingDelivery = await prisma.liveRoomDelivery.findFirst({
    where: { roomMessageId: dispatch.messageId },
    select: { id: true },
  });
  if (!existingDelivery) await triggerLiveRoomMessageReplies({
    roomId: room.id,
    roomMessageId: dispatch.messageId,
    requestedTargetMemberId: null,
    waitForCompletion: false,
  });
  args.signal.throwIfAborted();
  await prisma.workflowDispatch.update({
    where: { id: dispatch.id },
    data: { state: 'reply_queued' },
  });
}
