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

export async function runWorkflowInBoundLiveRoom(args: {
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  eventKey: string;
}) {
  const context: FeishuConversationContext = {
    chatId: args.chatId,
    chatType: args.chatType,
    senderOpenId: 'workflow-watcher',
    messageId: `workflow:${args.eventKey}`,
  };
  const reset = await handleNewSessionCommand({
    command: 'new-session',
    args: [],
    options: { all: 'true' },
  }, context);
  if (!reset.startsWith('✅')) throw new Error(reset);
  const room = await getBoundLiveRoom(context);
  const userMember = room?.members.find((member) => member.memberType === 'user');
  if (!room || !userMember) throw new Error('bound live room has no user member');
  const message = await postLiveRoomMessage({
    roomId: room.id,
    senderMemberId: userMember.id,
    content: args.prompt,
    messageType: 'user',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'user',
      extras: { source: 'workflow_watcher', eventKey: args.eventKey },
    }),
  });
  await triggerLiveRoomMessageReplies({
    roomId: room.id,
    roomMessageId: message.id,
    requestedTargetMemberId: null,
  });
}
