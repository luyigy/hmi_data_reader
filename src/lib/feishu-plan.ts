import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { getBoundLiveRoom, type FeishuConversationContext } from '@/lib/feishu-live-room';
import { ensureLiveRoomUserMember, postLiveRoomMessage } from '@/lib/live-room';
import { runLiveRoomPlan } from '@/lib/live-room-workflows';

export const handleFeishuPlanCommand = async (command: ParsedFeishuCommand, context?: FeishuConversationContext) => {
  const task = command.args.join(' ').trim();
  if (!task) return '用法：/ap plan [--host=<成员>] <需求>';
  const room = await getBoundLiveRoom(context);
  if (!room) return '当前 Feishu 会话尚未绑定 Live Room。请先使用 /ap room 创建绑定。';
  const sender = await ensureLiveRoomUserMember(room.id);
  const content = ['/plan', command.options.host ? `--host=${command.options.host}` : '', task].filter(Boolean).join(' ');
  const message = await postLiveRoomMessage({ roomId: room.id, senderMemberId: sender.id, content, messageType: 'user' });
  await runLiveRoomPlan({ roomId: room.id, sourceMessageId: message.id, content });
  return 'PLAN 讨论已完成；请查看 Room 中的阶段消息和提交结果。';
};
