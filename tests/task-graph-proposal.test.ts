import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { formatGraphProposal, handleGraphProposalCardAction } from '../src/lib/task-graph/proposals';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

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
  assert.match(cardText, /前置：V1/);
  assert.match(cardText, /local:pi-agent/);
  const parent = await prisma.task.create({ data: { name: `task-graph-proposal-test-${id}` } });
  try {
    const proposal = await prisma.taskGraphProposal.create({ data: {
      parentTaskId: parent.id, version: 1, snapshotHash: 'test', definition: definition as unknown as Prisma.InputJsonValue,
      createdBy: 'test', cardMessageId: 'test-card',
    } });
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    const forged = await handleGraphProposalCardAction({ proposalId: proposal.id,
      decision: 'approve', openId: 'attacker', chatId: 'wrong-chat', messageId: 'wrong-card' });
    assert.equal(forged.toast.type, 'warning');
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    assert.equal((await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status, 'pending');
    console.log('Task graph proposal approval boundary checks passed');
  } finally {
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
