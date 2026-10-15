import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { postGraphParentProgress } from './feishu';
import { taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';
import { validateExecutionTargets } from './launch';
import { createTaskGraphRun, releaseReadyNodes } from './store';

export function formatGraphProposal(definition: GraphDefinition, version: number) {
  const lines = [`任务路线 V${version}`, `Spec：${definition.specRef}`];
  for (const node of definition.nodes) {
    const jobs = node.executions.map((job) => `${job.repository} / ${job.agentSelector}`).join('；');
    lines.push(`**${node.key} · ${node.goal}**`);
    lines.push(`前置：${node.dependsOn.join('、') || '无'}；执行：${jobs}`);
    lines.push(`验收：${node.acceptance.mode}（${node.acceptance.checks.join('、')}）`);
  }
  return lines.join('\n');
}

/** A trusted local Agent proposes; no execution is released until the Feishu card is confirmed. */
export async function createGraphProposal(args: {
  parentTaskId: string; version?: number; definition: GraphDefinition; createdBy: string;
}) {
  const parent = await prisma.task.findUnique({ where: { id: args.parentTaskId }, select: { id: true } });
  if (!parent) throw new Error('父任务不存在');
  const definition = validateTaskGraphDefinition(args.definition);
  for (const node of definition.nodes) {
    if (node.acceptance.mode === 'human' && node.acceptance.reviewerId === 'self') {
      node.acceptance.reviewerId = (await prisma.task.findUniqueOrThrow({
        where: { id: args.parentTaskId }, select: { ownerUserId: true },
      })).ownerUserId || 'admin';
    }
  }
  await validateExecutionTargets(definition);
  const hash = taskGraphSnapshotHash(definition);
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: args.parentTaskId }, appId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!binding) throw new Error('父任务没有可发送确认卡的飞书话题绑定');
  const latest = await prisma.taskGraphProposal.findFirst({
    where: { parentTaskId: args.parentTaskId }, orderBy: { version: 'desc' },
  });
  const latestRun = await prisma.taskGraphRun.findFirst({
    where: { parentTaskId: args.parentTaskId }, orderBy: { version: 'desc' }, select: { version: true },
  });
  const version = args.version || (latest?.status === 'pending'
    ? latest.version : Math.max(latest?.version || 0, latestRun?.version || 0) + 1);
  const existing = await prisma.taskGraphProposal.findUnique({
    where: { parentTaskId_version: { parentTaskId: args.parentTaskId, version } },
  });
  if (existing && (existing.snapshotHash !== hash || existing.status !== 'pending')) {
    throw new Error(`路线 V${version} 已存在且内容或状态不同`);
  }
  const proposal = existing || await prisma.taskGraphProposal.create({ data: {
    parentTaskId: args.parentTaskId, version, snapshotHash: hash,
    definition: definition as unknown as Prisma.InputJsonValue, createdBy: args.createdBy.trim() || 'local-agent',
  } });
  if (proposal.cardMessageId) return proposal;
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `任务路线待确认 · V${version}` } },
    elements: [
      { tag: 'markdown', content: formatGraphProposal(definition, version) },
      { tag: 'div', text: { tag: 'plain_text', content: '确认后，所有无前置的任务自动启动；后续任务通过验收后自动接力。并行任务均使用独立 worktree。' } },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认并启动路线' },
          value: { cmd: 'task-graph-launch', proposalId: proposal.id, decision: 'approve' } },
        { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '退回修改' },
          value: { cmd: 'task-graph-launch', proposalId: proposal.id, decision: 'reject' } },
      ] },
    ],
  };
  const messageId = await sendFeishuInteractiveMessage({
    receiveId: binding.chatId, card, uuid: `task-graph-proposal-${proposal.id}`,
    ...(binding.rootMessageId ? { threadRootMessageId: binding.rootMessageId } : {}),
  });
  if (!messageId) throw new Error('飞书未返回路线确认卡消息 ID');
  return prisma.taskGraphProposal.update({
    where: { id: proposal.id }, data: { cardMessageId: messageId },
  });
}

export async function handleGraphProposalCardAction(args: {
  proposalId: string; decision: string; openId: string | null;
  chatId: string | null; messageId: string | null;
}) {
  if (!args.openId || !args.chatId || !args.messageId ||
      !['approve', 'reject'].includes(args.decision)) {
    return { toast: { type: 'warning', content: '路线卡身份信息不完整' } };
  }
  const proposal = await prisma.taskGraphProposal.findUnique({ where: { id: args.proposalId } });
  if (!proposal || proposal.status !== 'pending' || proposal.cardMessageId !== args.messageId) {
    return { toast: { type: 'warning', content: '路线卡已失效或正在处理' } };
  }
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { chatId: args.chatId, rootMessageId: { not: null }, liveRoom: { sourceTaskId: proposal.parentTaskId } },
  }) || await prisma.feishuConversationBinding.findFirst({
    where: { chatId: args.chatId, chatType: 'p2p', liveRoom: { sourceTaskId: proposal.parentTaskId } },
  });
  if (!binding || (!isFeishuAdmin(args.openId) &&
      !(binding.chatType === 'group' && await isFeishuGroupAdmin(args.chatId, args.openId)))) {
    return { toast: { type: 'warning', content: '只有父任务所在群的管理员可确认路线' } };
  }
  if (args.decision === 'reject') {
    const changed = await prisma.taskGraphProposal.updateMany({
      where: { id: proposal.id, status: 'pending' },
      data: { status: 'rejected', decidedBy: args.openId, decidedAt: new Date() },
    });
    if (changed.count !== 1) return { toast: { type: 'warning', content: '路线状态已变化' } };
    await postGraphParentProgress(proposal.parentTaskId, proposal.id, `路线 V${proposal.version} 已退回修改`);
    return { toast: { type: 'success', content: '已退回；Agent 可提出下一版' } };
  }
  const claim = await prisma.taskGraphProposal.updateMany({
    where: { id: proposal.id, status: 'pending' }, data: { status: 'processing' },
  });
  if (claim.count !== 1) return { toast: { type: 'warning', content: '路线正在由另一请求处理' } };
  try {
    const definition = validateTaskGraphDefinition(proposal.definition as unknown as GraphDefinition);
    if (taskGraphSnapshotHash(definition) !== proposal.snapshotHash) throw new Error('路线快照校验失败');
    await validateExecutionTargets(definition);
    const run = await createTaskGraphRun({
      parentTaskId: proposal.parentTaskId, version: proposal.version,
      requestKey: `feishu-proposal:${proposal.id}`, definition,
    });
    const released = await releaseReadyNodes(run.id);
    await prisma.taskGraphProposal.update({ where: { id: proposal.id }, data: {
      status: 'confirmed', decidedBy: args.openId, decidedAt: new Date(),
    } });
    await postGraphParentProgress(proposal.parentTaskId, run.id,
      `路线 V${proposal.version} 已确认；已放行 ${released.join('、') || '无'}`);
    return { toast: { type: 'success', content: `路线 V${proposal.version} 已启动` } };
  } catch (error) {
    await prisma.taskGraphProposal.updateMany({
      where: { id: proposal.id, status: 'processing' }, data: { status: 'pending' },
    });
    throw error;
  }
}
