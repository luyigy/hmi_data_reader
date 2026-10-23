import { inheritProjectCapabilityScopes } from '../project-capabilities/proposal';
import { prepareExtraRepositories } from './extra-repositories';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { listLiveRoomCatalogAgents, resolveLiveRoomAgentSelectors } from '../live-room';
import { postGraphParentProgress } from './feishu';
import { taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';
import { validateExecutionTargets } from './launch';
import { createTaskGraphRun, releaseReadyNodes } from './store';
import type { AcpxParticipantRequest } from '../acpx/types';
import { assertGraphCardBudget, buildGraphProposalCard, graphRolesReady } from './proposal-card';
import { configureGraphRoles, graphRoleOptions } from './role-configuration';
import { assertSpecPackage } from './spec-package';
import { deliverGraphArtifact } from './artifact-delivery';
export { buildGraphProposalCard, formatGraphProposal } from './proposal-card';

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
    participant = { gatewayId: agent.gatewayId, ...(agent.gatewayName ? { gatewayName: agent.gatewayName } : {}),
      executionBackend: 'platform_local', harnessType: agent.harnessType,
      ...(agent.runtimeAgentId ? { agentId: agent.runtimeAgentId } : {}),
      ...(agent.agentName ? { agentName: agent.agentName } : {}),
      role: args.target === 'architecture' ? 'reviewer' : args.target === 'acceptance' ? 'tester' : 'implementer' };
  }
  if (args.target === 'architecture') {
    if (!participant) throw new Error('架构复核者必须是本机 Agent');
    const review = { reviewerId: args.selector, reviewLaunchConfig: { participant } };
    if (args.nodeKey === 'all') definition.defaultArchitectureReview = review;
    else node!.architectureReview = review;
  } else if (args.target === 'acceptance' && node) {
    if (args.selector === 'automatic') {
      node.acceptance = { ...node.acceptance, mode: 'automatic' };
      delete node.acceptance.reviewerId;
      delete node.acceptance.reviewLaunchConfig;
    } else if (args.selector === 'human') {
      const parent = await prisma.task.findUniqueOrThrow({ where: { id: args.parentTaskId }, select: { ownerUserId: true } });
      node.acceptance = { ...node.acceptance, mode: 'human', reviewerId: parent.ownerUserId || 'admin' };
      delete node.acceptance.reviewLaunchConfig;
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
    buildGraphProposalCard(proposal.id, definition, proposal.version, hash, await graphRoleOptions(args.parentTaskId)));
  return { version: proposal.version, hash };
}

/** A trusted local Agent proposes; no execution is released until the Feishu card is confirmed. */
export async function createGraphProposal(args: {
  parentTaskId: string; version?: number; definition: GraphDefinition; createdBy: string;
}) {
  const parent = await prisma.task.findUnique({ where: { id: args.parentTaskId }, select: { id: true, ownerUserId: true } });
  if (!parent) throw new Error('父任务不存在');
  let definition = validateTaskGraphDefinition(args.definition.adoptRun ? args.definition : { ...args.definition, deliveryContract: 'agent_owned_v1' });
  await Promise.all(definition.nodes.map(node => prepareExtraRepositories(node.extraRepositories)));
  const specPackage = await assertSpecPackage(definition.specPackage);
  for (const node of definition.nodes) {
    if (node.acceptance.mode === 'human' && node.acceptance.reviewerId === 'self') {
      node.acceptance.reviewerId = parent.ownerUserId || 'admin';
    }
  }
  const options = definition.adoptRun ? [] : await graphRoleOptions(args.parentTaskId);
  definition = validateTaskGraphDefinition(configureGraphRoles({
    definition, options, form: {}, suggest: true, humanId: parent.ownerUserId || 'admin', preserveExplicitRoles: true,
  }));
  definition = await inheritProjectCapabilityScopes(definition);
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
  const card = buildGraphProposalCard(proposal.id, definition, version, hash, options);
  assertGraphCardBudget(card);
  if (specPackage) for (const artifact of specPackage.artifacts) await deliverGraphArtifact({
    parentTaskId: args.parentTaskId, chatId: binding.chatId, appId: binding.appId,
    rootMessageId: binding.rootMessageId, replyId: binding.rootMessageId || binding.latestMessageId || undefined,
    path: artifact.path, content: artifact.content,
  });
  const messageId = await sendFeishuInteractiveMessage({
    receiveId: binding.chatId,
    card,
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
  formValue?: Record<string, unknown>;
  page?: number;
}) {
  if (!args.openId || !args.chatId || !args.messageId ||
      !['approve', 'reject', 'configure', 'suggest', 'page', 'expand'].includes(args.decision)) {
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
  const adoption = (proposal.definition as unknown as GraphDefinition).adoptRun;
  if (adoption && (!['approve', 'reject'].includes(args.decision) || Object.keys(args.formValue || {}).length)) return { toast: { type: 'warning', content: '关联保留原分工与模式，不在此卡改派或重启' } };
  if (args.decision === 'expand') {
    const options = await graphRoleOptions(proposal.parentTaskId);
    const card = buildGraphProposalCard(proposal.id, proposal.definition as unknown as GraphDefinition,
      proposal.version, proposal.snapshotHash, options, args.page ?? 0);
    assertGraphCardBudget(card);
    await updateFeishuTaskEntryCard(proposal.cardMessageId, card);
    return { toast: { type: 'success', content: '已展开角色配置' } };
  }
  if (args.decision === 'configure' || args.decision === 'suggest' || args.decision === 'page' ||
      (args.decision === 'approve' && Object.keys(args.formValue || {}).length > 0)) {
    const parent = await prisma.task.findUniqueOrThrow({ where: { id: proposal.parentTaskId }, select: { ownerUserId: true } });
    const options = await graphRoleOptions(proposal.parentTaskId);
    const definition = configureGraphRoles({ definition: proposal.definition as unknown as GraphDefinition,
      options, form: args.formValue || {}, suggest: args.decision === 'suggest', humanId: parent.ownerUserId || 'admin' });
    validateTaskGraphDefinition(definition);
    await validateExecutionTargets(definition);
    const hash = taskGraphSnapshotHash(definition);
    if (args.decision !== 'approve' || hash !== proposal.snapshotHash) {
      const card = buildGraphProposalCard(proposal.id, definition, proposal.version, hash, options, args.page);
      assertGraphCardBudget(card);
      const changed = await prisma.taskGraphProposal.updateMany({
        where: { id: proposal.id, status: 'pending', snapshotHash: args.hash },
        data: { snapshotHash: hash, definition: definition as unknown as Prisma.InputJsonValue },
      });
      if (changed.count !== 1) return { toast: { type: 'warning', content: '路线已更新，请使用最新卡片' } };
      await updateFeishuTaskEntryCard(proposal.cardMessageId!, card);
      return { toast: { type: 'success', content: args.decision === 'page' ? '已保存本页并切换角色配置页' : '模式与角色已保存，请核对更新后的卡片再确认' } };
    }
  }
  if (args.decision === 'reject') {
    const changed = await prisma.taskGraphProposal.updateMany({
      where: { id: proposal.id, status: 'pending', snapshotHash: proposal.snapshotHash },
      data: { status: 'rejected', decidedBy: args.openId, decidedAt: new Date() },
    });
    if (changed.count !== 1) return { toast: { type: 'warning', content: '路线状态已变化' } };
    await postGraphParentProgress(proposal.parentTaskId, proposal.id, `路线 V${proposal.version} 已退回修改`);
    return { toast: { type: 'success', content: '已退回；Agent 可提出下一版' } };
  }
  const configured = proposal.definition as unknown as GraphDefinition;
  if (!graphRolesReady(configured)) {
    return { toast: { type: 'warning', content: '请先指定所有 Slice 的架构复核者' } };
  }
  const claim = await prisma.taskGraphProposal.updateMany({
    where: { id: proposal.id, status: 'pending', snapshotHash: proposal.snapshotHash }, data: { status: 'processing',
      ...(adoption ? { decidedBy: args.openId, decidedAt: new Date() } : {}) },
  });
  if (claim.count !== 1) return { toast: { type: 'warning', content: '路线正在由另一请求处理' } };
  if (adoption) return { toast: { type: 'success', content: '已收到关联确认，后台核对 Issues 后回报；现有任务进度保持' } };
  try {
    const definition = validateTaskGraphDefinition(proposal.definition as unknown as GraphDefinition);
    if (taskGraphSnapshotHash(definition) !== proposal.snapshotHash) throw new Error('路线快照校验失败');
    await Promise.all(definition.nodes.map(node => prepareExtraRepositories(node.extraRepositories)));
    await assertSpecPackage(definition.specPackage);
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
