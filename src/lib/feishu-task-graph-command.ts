import { prisma } from './prisma';
import { getBoundLiveRoom, type FeishuConversationContext } from './feishu-live-room';
import type { ParsedFeishuCommand } from './feishu-command-parser';

export async function handleFeishuTaskGraphCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (command.args[0] !== 'status' || command.args.length > 1) return '用法：/ap graph status';
  const room = await getBoundLiveRoom(context);
  if (!room?.sourceTaskId) return '请在父任务话题内查询任务路线。';
  const run = await prisma.taskGraphRun.findFirst({
    where: { parentTaskId: room.sourceTaskId }, orderBy: { version: 'desc' },
    include: { nodes: { orderBy: { createdAt: 'asc' } } },
  });
  if (!run) return '当前父任务还没有已确认的任务路线。请先让 Agent 提出 Spec 和排期，在父任务页面确认一次。';
  const labels: Record<string, string> = {
    planned: '等待前置', ready: '已放行', claimed: '执行中', verifying: '验收中',
    awaiting_human: '待人工验收', passed: '已通过', attention: '需处理',
  };
  return [`任务路线 V${run.version} · ${run.status} · ${run.id}`,
    ...run.nodes.map((node) => `${node.key}：${labels[node.status] || node.status}${node.dependsOn.length ? `（前置 ${node.dependsOn.join('、')}）` : ''}`),
  ].join('\n');
}
