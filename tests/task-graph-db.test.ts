import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes } from '../src/lib/task-graph/store';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  const id = randomUUID();
  const parent = await prisma.task.create({ data: { name: `task-graph-db-test-${id}` } });
  const definition: GraphDefinition = { specRef: `test://${id}`, nodes: [
    { key: 'V1', goal: 'Smoke test', dependsOn: [], acceptance: { mode: 'automatic', checks: ['smoke'] },
      executions: [{ key: 'api', instructions: 'Run smoke check', repository: '/data1/code/example',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }] },
    { key: 'V2', goal: 'Dependent test', dependsOn: ['V1'], acceptance: { mode: 'automatic', checks: ['smoke'] },
      executions: [{ key: 'api', instructions: 'Run next check', repository: '/data1/code/example',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }] },
  ] };
  try {
    const args = { parentTaskId: parent.id, version: 1, requestKey: id, definition };
    const run = await createTaskGraphRun(args);
    assert.equal((await createTaskGraphRun(args)).id, run.id);
    assert.deepEqual(await releaseReadyNodes(run.id), ['V1']);
    assert.deepEqual(await releaseReadyNodes(run.id), []);
    assert.equal((await claimNode(run.id, 'V1', id))?.status, 'claimed');
    assert.equal((await claimExecution(run.id, 'V1', 'api', id))?.status, 'claimed');
    const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, orderBy: { key: 'asc' } });
    assert.deepEqual(nodes.map((node) => node.status), ['claimed', 'planned']);
    console.log('Task graph PostgreSQL persistence checks passed');
  } finally {
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
