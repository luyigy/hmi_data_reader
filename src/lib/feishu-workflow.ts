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
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';

export const buildWorkflowExecutionCard = (workflowContext: string | undefined, prompt: string) => {
  const instruction = workflowContext && prompt.startsWith(`${workflowContext}\n\n`)
    ? prompt.slice(workflowContext.length + 2)
    : prompt;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Workflow · Coding Session' },
    },
    elements: [
      ...(workflowContext ? [{ tag: 'markdown', content: workflowContext }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: instruction },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '以上指令已投递给 Coding Agent；请等待本阶段完成后再继续。' }] },
    ],
  };
};

export async function runWorkflowInBoundLiveRoom(args: {
  projectId: string;
  jobId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  workflowContext?: string;
  eventKey: string;
  signal: AbortSignal;
}): Promise<boolean> {
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
  if (dispatch.state === 'reply_queued') return true;
  args.signal.throwIfAborted();

  const context: FeishuConversationContext = {
    chatId: args.chatId,
    chatType: args.chatType,
    senderOpenId: 'workflow-watcher',
    messageId: `workflow:${args.eventKey}`,
  };
  const boundRoom = await getBoundLiveRoom(context);
  if (!boundRoom?.sourceTask) throw new Error('bound live room has no source task');

  // A committed HANDOVER can be visible before its agent has emitted its final reply.
  // Keep the watcher event pending; the task-completion wakeup will retry it.
  if (dispatch.state === 'prepared') {
    const active = await prisma.taskRun.count({
      where: { taskId: boundRoom.sourceTask.id, status: 'running' },
    });
    if (active) return false;
  }

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
    const feishuMessageId = await sendFeishuInteractiveMessage({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      card: buildWorkflowExecutionCard(args.workflowContext, args.prompt),
    });
    if (!feishuMessageId) throw new Error('Feishu workflow card response missing message_id');
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
  return true;
}
