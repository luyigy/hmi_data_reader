import { prisma } from './prisma';
import { getBoundLiveRoom, type FeishuConversationContext } from './feishu-live-room';
import type { ParsedFeishuCommand } from './feishu-command-parser';

export async function handleFeishuTaskGraphCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (command.args[0] !== 'status' || command.args.length > 1) return '用法：/ap graph status。请直接在父任务话题让 Agent 提出路线；平台会发确认卡。';
  const room = await getBoundLiveRoom(context);
  if (!room?.sourceTaskId) return '请在父任务话题内查询任务路线。';
  const proposal = await prisma.taskGraphProposal.findFirst({
    where: { parentTaskId: room.sourceTaskId }, orderBy: { version: 'desc' },
    select: { version: true, status: true, cardMessageId: true },
  });
  const run = await prisma.taskGraphRun.findFirst({
    where: { parentTaskId: room.sourceTaskId }, orderBy: { version: 'desc' },
    include: { nodes: { orderBy: { createdAt: 'asc' } } },
  });
  if (!run) return proposal
    ? `任务路线 V${proposal.version}：${proposal.status}。${proposal.cardMessageId ? '请在本话题的路线卡上确认或退回。' : '路线卡尚未发送成功，请让 Agent 重试提交。'}`
    : '当前父任务还没有任务路线。请让 Agent 根据定稿 Spec 提出排期，平台会在本话题发确认卡。';
  const labels: Record<string, string> = {
    planned: '等待前置', ready: '已放行', claimed: '执行中', verifying: '验收中',
    awaiting_human: '待人工验收', passed: '已通过', attention: '需处理',
  };
  return [`任务路线 V${run.version} · ${run.status} · ${run.id}`,
    ...(proposal && proposal.version > run.version ? [`待确认提议 V${proposal.version} · ${proposal.status}`] : []),
    ...run.nodes.map((node) => `${node.key}：${labels[node.status] || node.status}${node.dependsOn.length ? `（前置 ${node.dependsOn.join('、')}）` : ''}`),
  ].join('\n');
}
