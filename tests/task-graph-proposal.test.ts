import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { buildGraphProposalCard, formatGraphProposal, handleGraphProposalCardAction } from '../src/lib/task-graph/proposals';
import type { GraphDefinition } from '../src/lib/task-graph/domain';
import { graphCardContext } from '../src/lib/feishu-graph-picker';

async function main() {
  const id = randomUUID();
  const definition: GraphDefinition = { specRef: `test://${id}`, nodes: [
    { key: 'V1', goal: 'First result', dependsOn: [], acceptance: { mode: 'automatic', checks: ['smoke'] },
      executions: [{ key: 'reader', instructions: 'Implement', repository: '/data1/code/reader',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }] },
    { key: 'V2', goal: 'Next result', dependsOn: ['V1'], acceptance: { mode: 'human', reviewerId: 'admin', checks: ['smoke'] },
      executions: [{ key: 'app', instructions: 'Implement', repository: '/data1/code/app',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:pi-agent' }] },
  ] };
  const cardText = formatGraphProposal(definition, 1);
  assert.match(cardText, /V2 · Next result/);
  assert.match(cardText, /V1 → V2/);
  const roadmap = formatGraphProposal({ ...definition, nodes: [
    definition.nodes[0],
    { ...definition.nodes[1], acceptance: { mode: 'automatic', checks: ['smoke'] } },
    { ...definition.nodes[1], key: 'V3', dependsOn: ['V2'] },
    { ...definition.nodes[1], key: 'V4', dependsOn: ['V3'] },
    { ...definition.nodes[1], key: 'V5', dependsOn: ['V2'] },
  ] }, 1);
  assert.match(roadmap, /V2 → V3 ∥ V5/);
  assert.match(roadmap, /V3 → V4/);
  assert.match(cardText, /前置：V1/);
  assert.match(cardText, /local:pi-agent/);
  const incompleteCard = buildGraphProposalCard('proposal', definition, 1, 'hash');
  assert.doesNotMatch(JSON.stringify(incompleteCard), /确认并启动路线/);
  const withArchitect: GraphDefinition = { ...definition, defaultArchitectureReview: {
    reviewerId: 'local:codex', reviewLaunchConfig: { participant: { gatewayId: 'local',
      executionBackend: 'platform_local', harnessType: 'codex', role: 'reviewer' } },
  } };
  const readyCard = buildGraphProposalCard('proposal', withArchitect, 1, 'hash');
  assert.match(JSON.stringify(readyCard), /确认并启动路线/);
  assert.match(formatGraphProposal(withArchitect, 1), /架构复核者：local:codex/);
  const parent = await prisma.task.create({ data: { name: `task-graph-proposal-test-${id}` } });
  const room = await prisma.liveRoom.create({ data: { title: `graph-test-${id}`, sourceTaskId: parent.id } });
  try {
    const proposal = await prisma.taskGraphProposal.create({ data: {
      parentTaskId: parent.id, version: 1, snapshotHash: 'test', definition: definition as unknown as Prisma.InputJsonValue,
      createdBy: 'test', cardMessageId: 'test-card',
    } });
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    const forged = await handleGraphProposalCardAction({ proposalId: proposal.id,
      decision: 'approve', hash: 'test', openId: 'attacker', chatId: 'wrong-chat', messageId: 'wrong-card' });
    assert.equal(forged.toast.type, 'warning');
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    assert.equal((await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status, 'pending');
    await prisma.feishuConversationBinding.create({ data: { scopeKey: `test-${id}`, chatId: `chat-${id}`,
      chatType: 'group', appId: 'test-app', threadId: `thread-${id}`, rootMessageId: `root-${id}`, liveRoomId: room.id } });
    const context = await graphCardContext({ roomId: room.id, chatId: `chat-${id}`, openId: 'admin', messageId: 'card', chatType: 'group' });
    assert.equal(context.rootId, `root-${id}`);
    assert.equal(context.threadId, `thread-${id}`);
    await assert.rejects(() => graphCardContext({ roomId: room.id, chatId: 'other-chat', openId: 'admin', messageId: 'card', chatType: 'group' }), /绑定不匹配/);
    await prisma.taskGraphProposal.update({ where: { id: proposal.id }, data: { snapshotHash: 'changed' } });
    const stale = await handleGraphProposalCardAction({ proposalId: proposal.id, decision: 'approve', hash: 'test',
      openId: 'admin', chatId: `chat-${id}`, messageId: 'test-card' });
    assert.match(stale.toast.content, /失效/);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    console.log('Task graph proposal approval boundary checks passed');
  } finally {
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
