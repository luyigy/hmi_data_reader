import { prisma } from './prisma';
import { getBoundLiveRoom, type FeishuConversationContext } from './feishu-live-room';
import { ensureLiveRoomUserMember, postLiveRoomMessage, resolveLiveRoomMessageMetadata } from './live-room';
import { triggerLiveRoomMessageReplies } from './live-room-delivery';
import type { ParsedFeishuCommand } from './feishu-command-parser';
import { updateGraphProposalRole } from './task-graph/proposals';
import { openGraphSpecPicker } from './feishu-graph-picker';

export async function handleFeishuTaskGraphCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (!['status', 'propose', 'role'].includes(command.args[0])) {
    return '用法：/ap graph propose [Spec 路径]、/ap graph role <Slice|all> <仓内任务|acceptance|architecture> <Agent|automatic|human>，或 /ap graph status。';
  }
  const room = await getBoundLiveRoom(context);
  if (!room?.sourceTaskId) return '请在父任务话题内查询任务路线。';
  if (command.args[0] === 'role') {
    if (command.args.length !== 4) return '用法：/ap graph role <Slice|all> <仓内任务|acceptance|architecture> <Agent|automatic|human>。';
    if (!context?.chatId || !context.senderOpenId) return '飞书身份信息不完整，无法调整路线角色。';
    try {
      const result = await updateGraphProposalRole({
        parentTaskId: room.sourceTaskId, chatId: context.chatId, openId: context.senderOpenId,
        nodeKey: command.args[1], target: command.args[2], selector: command.args[3],
      });
      return `路线 V${result.version} 的角色已更新，请查看本话题中的路线卡。`;
    } catch (error) {
      return `角色调整失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (command.args[0] === 'propose') {
    if (!command.args.slice(1).join(' ').trim() && context) return openGraphSpecPicker(context);
    const target = room.members.find((member) => member.id === room.currentSpeakerMemberId && member.canReply)
      || room.members.find((member) => member.memberType !== 'user' && member.canReply);
    if (!target) return '父任务房间没有可回复的 Agent；请先加入 Agent。';
    const spec = command.args.slice(1).join(' ').trim();
    const user = await ensureLiveRoomUserMember(room.id);
    const content = [
      `请根据${spec ? ` ${spec} ` : '当前父任务已讨论的 Spec '}提出任务图路线，先审查依赖、仓库、并行任务和验收条件。`,
      '将完整路线写成 JSON，校验仓库的已提交 Git 基线和 Agent 配置，',
      `然后在平台仓执行 npm run task-graph:propose -- --parent-task-id=${room.sourceTaskId} --file=<路线JSON> --agent=<你的名称>。`,
      ...(command.options['spec-package'] ? [
        `提交命令还须加 --spec-repository=${command.options['spec-repository']} --spec-package=${command.options['spec-package']}，所选包提交为 ${command.options['spec-commit']}；如版本变化重新提审。`,
      ] : []),
      '沿 Spec 包生成纵向 tickets 和路线，不再创建 PLAN/HANDOVER。实施者按房间角色建议；完整/精简/仅实施模式逐片明确。',
      '这一步只发飞书确认卡，不启动实施。若有缺少的实图、基准真值或脏工作区，请在路线卡前说明。',
    ].join('');
    const message = await postLiveRoomMessage({
      roomId: room.id, senderMemberId: user.id, messageType: 'user', content,
      metadata: resolveLiveRoomMessageMetadata({ senderKind: 'user', targetMemberId: target.id,
        extras: { source: 'feishu_task_graph_propose', feishuChatId: context?.chatId,
          feishuMessageId: context?.messageId } }),
    });
    void triggerLiveRoomMessageReplies({ roomId: room.id, roomMessageId: message.id,
      requestedTargetMemberId: target.id }).catch((error) => {
        console.error('[TaskGraph] proposal Agent trigger failed:', error);
      });
    return `已请 ${target.userNickname || target.displayName} 提出路线；完成后确认卡会发到本父任务话题。确认卡出现前不会启动实施。`;
  }
  if (command.args.length > 1) return '用法：/ap graph status';
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
    awaiting_human: '待人工验收', passed: '已通过', attention: '需处理', delivered_unverified: '已交付（未验收）',
  };
  return [`任务路线 V${run.version} · ${run.status} · ${run.id}`,
    ...(proposal && proposal.version > run.version ? [`待确认提议 V${proposal.version} · ${proposal.status}`] : []),
    ...run.nodes.map((node) => `${node.key}：${labels[node.status] || node.status}${node.dependsOn.length ? `（前置 ${node.dependsOn.join('、')}）` : ''}`),
  ].join('\n');
}
