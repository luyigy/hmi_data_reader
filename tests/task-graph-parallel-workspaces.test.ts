import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes } from '../src/lib/task-graph/store';
import type { GraphDefinition, GraphNode } from '../src/lib/task-graph/domain';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'parallel workspaces fixture' } });
  const node = (key: string, repository: string, extraRepositories: GraphNode['extraRepositories'] = []): GraphNode => ({
    key, goal: key, dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, extraRepositories,
    executions: [{ key: 'job', instructions: key, repository, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }],
  });
  let version = 0;
  const make = async (nodes: GraphNode[]) => {
    const definition: GraphDefinition = { specRef: 'test://parallel', nodes };
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: ++version, requestKey: randomUUID(), definition });
    await releaseReadyNodes(run.id); return run;
  };
  try {
    const run = await make([
      node('A', '/fixture/reader', [{ repository: '/fixture/model', access: 'read' }]),
      node('B', '/fixture/reader', [{ repository: '/fixture/model', access: 'read' }]),
      node('C', '/fixture/model', [{ repository: '/fixture/reader', access: 'read' }]),
    ]);
    const claims = await Promise.all(['A', 'B', 'C'].map(key => claimNode(run.id, key, key)));
    assert.equal(claims.filter(Boolean).length, 3, 'Independent primary worktrees and shared readonly originals must run concurrently');
    await prisma.taskGraphNode.updateMany({ where: { runId: run.id, key: 'A' }, data: { status: 'attention' } });
    const independent = await make([node('D', '/fixture/reader')]);
    assert.ok(await claimNode(independent.id, 'D', 'd'), 'An isolated paused primary must not lock its original repository');
    const writers = await make([
      node('W1', '/fixture/w1', [{ repository: '/fixture/shared', access: 'write' }]),
      node('W2', '/fixture/w2', [{ repository: '/fixture/shared', access: 'write' }]),
    ]);
    const shared = await Promise.all(['W1', 'W2'].map(key => claimNode(writers.id, key, key)));
    assert.equal(shared.filter(Boolean).length, 1, 'Actual shared original writers remain mutually exclusive');
    const otherRun = await make([node('READ', '/fixture/other', [{ repository: '/fixture/shared', access: 'read' }])]);
    assert.equal(await claimNode(otherRun.id, 'READ', 'reader'), null, 'Shared original conflicts must be protected across graph runs');
    await prisma.taskGraphNode.updateMany({ where: { runId: writers.id, status: 'claimed' }, data: { status: 'passed' } });
    assert.ok(await claimNode(otherRun.id, 'READ', 'reader'));
    const multi = node('MULTI', '/fixture/a', [{ repository: '/fixture/multi-shared', access: 'write' }]);
    multi.executions.push({ ...multi.executions[0], key: 'second', repository: '/fixture/b' });
    const multiRun = await make([multi]);
    await claimNode(multiRun.id, multi.key, 'multi');
    const siblings = await Promise.all(multi.executions.map(job => claimExecution(multiRun.id, multi.key, job.key, job.key)));
    assert.equal(siblings.filter(Boolean).length, 1, 'Sibling jobs sharing a writable extra directory must serialize too');
    console.log('Independent primary worktrees run concurrently; paused isolated work does not block; shared originals remain protected across runs');
  } finally { await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } }); await prisma.task.delete({ where: { id: parent.id } }); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
