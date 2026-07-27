import { prisma } from '@/lib/prisma';
import { getBoundLiveRoom, resolveRoomMemberQuery, type FeishuConversationContext } from '@/lib/feishu-live-room';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-delivery';
import { getPersistedHarnessPid } from '@/lib/live-room-interrupt';
import { cancelQueuedLiveRoomMemberExecutions } from '@/lib/live-room-process-registry';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';

export async function handleStopAgentCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  const room = await getBoundLiveRoom(context);
  if (!room?.sourceTask) return '当前 Feishu 会话未绑定 live room，无法停止 Agent。';

  const query = (command.options.agent || command.args.join(' ')).trim();
  const all = command.options.all === 'true' || query.toLowerCase() === 'all';
  const members = all
    ? room.members.filter((member) => member.memberType !== 'user' && member.canReply)
    : [resolveRoomMemberQuery({ room, query })].filter((member) => member !== null);
  if (!members.length) return query ? `找不到目标成员：${query}` : '当前房间没有可停止的 Agent。';

  const results = await Promise.all(members.map(async (member) => {
    cancelQueuedLiveRoomMemberExecutions(member.id);
    const result = await interruptLiveRoomMemberReplies({
      roomId: room.id,
      memberId: member.id,
      controlAction: 'stop_run',
    });
    return {
      name: member.userNickname || member.displayName,
      ...result,
    };
  }));
  const stopped = results.reduce((sum, result) => sum + result.interruptedRunningCount, 0);
  const queued = results.reduce((sum, result) => sum + result.cancelledQueuedCount, 0);
  const failed = results.reduce((sum, result) => sum + result.failedRunningCount, 0);

  if (failed) return `❌ ${failed} 个 Agent 运行未能终止；PID 校验失败或进程不可接管，请查看 /ap sessions。`;
  return stopped || queued
    ? `✅ 已停止 ${stopped} 个运行，并清理 ${queued} 条排队消息。`
    : `当前没有${all ? '' : ` ${results[0].name}`}正在运行或排队的 Agent 会话。`;
}

export async function handleAgentSessionsCommand() {
  const participants = await prisma.taskRunParticipant.findMany({
    where: {
      executionBackend: 'platform_local',
      controlMetadata: { not: null },
    },
    orderBy: { startedAt: 'desc' },
    take: 200,
    include: {
      taskRun: {
        include: {
          task: { select: { name: true } },
        },
      },
    },
  });

  const active = (await Promise.all(participants.map(async (participant) => ({
    participant,
    pid: await getPersistedHarnessPid(participant.controlMetadata, participant.harnessType),
  })))).filter((entry) => entry.pid !== null);
  if (!active.length) return '平台当前实际存活的 Agent 进程：0';
  const lines = active.map(({ participant, pid }) =>
    `- ${participant.harnessNameSnapshot || participant.harnessType} · ${participant.taskRun.task.name} · run=${participant.taskRunId} · pid=${pid} · db=${participant.status}`);
  return [`平台当前实际存活的 Agent 进程：${active.length}`, ...lines].join('\n');
}
