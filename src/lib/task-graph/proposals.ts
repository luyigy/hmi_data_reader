import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { listLiveRoomCatalogAgents, resolveLiveRoomAgentSelectors } from '../live-room';
import { postGraphParentProgress } from './feishu';
import { effectiveArchitectureReview, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';
import { validateExecutionTargets } from './launch';
import { createTaskGraphRun, releaseReadyNodes } from './store';
import type { AcpxParticipantRequest } from '../acpx/types';

export function formatGraphProposal(definition: GraphDefinition, version: number) {
  const lines = [`任务路线 V${version}`, `Spec：${definition.specRef}`, '**依赖关系图**'];
  const successors = new Map(definition.nodes.map((node) => [node.key, [] as string[]]));
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) successors.get(dependency)?.push(node.key);
  }
  for (const [key, next] of Array.from(successors)) {
    if (next.length) lines.push(`${key} → ${next.join(' ∥ ')}${next.length > 1 ? '（前置通过后可并行）' : ''}`);
  }
  lines.push('每个节点只等待其声明的前置；不同仓和同仓并行均使用独立 worktree。', '**各节点交付**');
  for (const node of definition.nodes) {
    const jobs = node.executions.map((job) => `${job.repository} / ${job.agentSelector}`).join('；');
    lines.push(`**${node.key} · ${node.goal}**`);
    lines.push(`前置：${node.dependsOn.join('、') || '无'}`);
    lines.push(`实施者：${jobs}`);
    lines.push(`验收者：${node.acceptance.mode === 'automatic' ? '自动检查' : node.acceptance.reviewerId || '未配置'}；验收项：${node.acceptance.checks.join('、')}`);
    lines.push(`架构复核者：${effectiveArchitectureReview(definition, node)?.reviewerId || '未配置'}`);
  }
  return lines.join('\n');
}

export function buildGraphProposalCard(id: string, definition: GraphDefinition, version: number, hash: string) {
  const ready = definition.nodes.every((node) => !!effectiveArchitectureReview(definition, node));
  return {
    config: { wide_screen_mode: true },
    header: { template: ready ? 'blue' : 'orange', title: { tag: 'plain_text', content: `任务路线待确认 · V${version}` } },
    elements: [
      { tag: 'markdown', content: formatGraphProposal(definition, version) },
      { tag: 'div', text: { tag: 'plain_text', content: ready
        ? '确认后，无前置任务自动启动；后续任务通过架构复核与验收后接力。并行任务各用独立 worktree。'
        : '请先用 /ap graph role all architecture <本机 Agent> 指定架构复核者。角色调整后本卡会更新。' } },
      { tag: 'div', text: { tag: 'plain_text', content:
        '改派示例：/ap graph role V3 collector local:pi-agent；/ap graph role V3 acceptance local:kimi-code；/ap graph role V3 architecture local:codex。' } },
      { tag: 'action', actions: [
        ...(ready ? [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认并启动路线' },
          value: { cmd: 'task-graph-launch', proposalId: id, decision: 'approve', hash } }] : []),
        { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '退回修改' },
          value: { cmd: 'task-graph-launch', proposalId: id, decision: 'reject', hash } },
      ] },
    ],
  };
}

export async function updateGraphProposalRole(args: {
  parentTaskId: string; chatId: string; openId: string;
  nodeKey: string; target: string; selector: string;
}) {
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { chatId: args.chatId, liveRoom: { sourceTaskId: args.parentTaskId } },
  });
  if (!binding || (!isFeishuAdmin(args.openId) &&
      !(binding.chatType === 'group' && await isFeishuGroupAdmin(args.chatId, args.openId)))) {
    throw new Error('只有父任务所在群的管理员可调整路线角色');
  }
  const proposal = await prisma.taskGraphProposal.findFirst({
    where: { parentTaskId: args.parentTaskId, status: 'pending' }, orderBy: { version: 'desc' },
  });
  if (!proposal?.cardMessageId) throw new Error('没有可调整的待确认路线卡');
  const definition = structuredClone(proposal.definition) as GraphDefinition;
  const node = definition.nodes.find((item) => item.key === args.nodeKey);
  if (args.nodeKey !== 'all' && !node) throw new Error(`路线中没有 ${args.nodeKey}`);
  let participant: AcpxParticipantRequest | null = null;
  if (!['human', 'automatic'].includes(args.selector)) {
    const [agentId] = await resolveLiveRoomAgentSelectors([args.selector]);
    const agent = (await listLiveRoomCatalogAgents()).find((item) => item.id === agentId);
    if (!agent || agent.backend !== 'platform_local') {
      throw new Error('首版任务图角色只能选择已登记的本机 Agent');
    }
    participant = { gatewayId: agent.gatewayId, gatewayName: agent.gatewayName,
      executionBackend: 'platform_local', harnessType: agent.harnessType,
      agentId: agent.runtimeAgentId, agentName: agent.agentName,
      role: args.target === 'architecture' ? 'reviewer' : args.target === 'acceptance' ? 'tester' : 'implementer' };
  }
  if (args.target === 'architecture') {
    if (!participant) throw new Error('架构复核者必须是本机 Agent');
    const review = { reviewerId: args.selector, reviewLaunchConfig: { participant } };
    if (args.nodeKey === 'all') definition.defaultArchitectureReview = review;
    else node!.architectureReview = review;
  } else if (args.target === 'acceptance' && node) {
    if (args.selector === 'automatic') {
      const { reviewerId: _reviewerId, reviewLaunchConfig: _reviewLaunchConfig, ...rest } = node.acceptance;
      node.acceptance = { ...rest, mode: 'automatic' };
    } else if (args.selector === 'human') {
      const parent = await prisma.task.findUniqueOrThrow({ where: { id: args.parentTaskId }, select: { ownerUserId: true } });
      const { reviewLaunchConfig: _reviewLaunchConfig, ...rest } = node.acceptance;
      node.acceptance = { ...rest, mode: 'human', reviewerId: parent.ownerUserId || 'admin' };
    } else {
      node.acceptance = { ...node.acceptance, mode: 'agent', reviewerId: args.selector,
        reviewLaunchConfig: { participant } };
    }
  } else if (node) {
    if (!participant) throw new Error('实施者必须是本机 Agent');
    const execution = node.executions.find((item) => item.key === args.target);
    if (!execution) throw new Error(`${node.key} 没有仓内任务 ${args.target}`);
    const current = execution.launchConfig as { checks?: unknown[] } | undefined;
    execution.agentSelector = args.selector;
    execution.launchConfig = { ...current, participant };
  } else {
    throw new Error('只有 architecture 支持 all 范围');
  }
  validateTaskGraphDefinition(definition);
  await validateExecutionTargets(definition);
  const hash = taskGraphSnapshotHash(definition);
  const updated = await prisma.taskGraphProposal.updateMany({
    where: { id: proposal.id, status: 'pending', snapshotHash: proposal.snapshotHash },
    data: { snapshotHash: hash, definition: definition as unknown as Prisma.InputJsonValue },
  });
  if (updated.count !== 1) throw new Error('路线已被其他操作修改，请重新查看卡片');
  await updateFeishuTaskEntryCard(proposal.cardMessageId,
    buildGraphProposalCard(proposal.id, definition, proposal.version, hash));
  return { version: proposal.version, hash };
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
  const messageId = await sendFeishuInteractiveMessage({
    receiveId: binding.chatId,
    card: buildGraphProposalCard(proposal.id, definition, version, hash),
    uuid: `task-graph-proposal-${proposal.id}`,
    ...(binding.rootMessageId ? { threadRootMessageId: binding.rootMessageId } : {}),
  });
  if (!messageId) throw new Error('飞书未返回路线确认卡消息 ID');
  return prisma.taskGraphProposal.update({
    where: { id: proposal.id }, data: { cardMessageId: messageId },
  });
}

export async function handleGraphProposalCardAction(args: {
  proposalId: string; decision: string; hash: string | null; openId: string | null;
  chatId: string | null; messageId: string | null;
}) {
  if (!args.openId || !args.chatId || !args.messageId ||
      !['approve', 'reject'].includes(args.decision)) {
    return { toast: { type: 'warning', content: '路线卡身份信息不完整' } };
  }
  const proposal = await prisma.taskGraphProposal.findUnique({ where: { id: args.proposalId } });
  if (!proposal || proposal.status !== 'pending' || proposal.cardMessageId !== args.messageId ||
      proposal.snapshotHash !== args.hash) {
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
  const configured = proposal.definition as unknown as GraphDefinition;
  if (!configured.nodes.every((node) => !!effectiveArchitectureReview(configured, node))) {
    return { toast: { type: 'warning', content: '请先指定所有 Slice 的架构复核者' } };
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
