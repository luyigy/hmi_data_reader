import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { scheduleGraphRepair } from '../src/lib/task-graph/repair';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const task = await prisma.task.create({ data: { name: 'targeted repair' } });
  const run = await createTaskGraphRun({ parentTaskId: task.id, version: 1, requestKey: task.id, definition: {
    specRef: 'test://targeted-repair', nodes: [{ key: 'BOTH', goal: 'Joint behavior', dependsOn: [],
      acceptance: { mode: 'automatic', checks: ['contract'] }, executions: ['reader', 'model'].map(key => ({
        key, repository: `/tmp/${key}`, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40),
        agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } },
      })),
    }],
  } });
  try {
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'BOTH' } }, include: { executions: true } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of node.executions) {
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit: (job.key === 'reader' ? 'b' : 'c').repeat(40), evidence: { summary: `${job.key} original evidence` } } });
    }
    const reader = node.executions.find(job => job.key === 'reader');
    const model = node.executions.find(job => job.key === 'model');
    assert(reader && model);
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: model.id } });
    const decision = { failureKind: 'in_scope_defect', failureKey: 'acceptance:contract', note: 'Reader misses required raw field', executionIds: [reader.id] };
    const evidence = { summary: 'Joint check found a reader defect', checks: [{ name: 'contract', passed: false, evidence: 'missing field' }] };
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, executionIds: ['another-node'] }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, failureKey: 'unknown' }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, executionIds: undefined }, evidence), false, 'Multi-execution defect needs explicit attribution');
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', decision, evidence), true);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: model.id } });
    assert.equal(after.status, 'integrated', 'Successful sibling must stay integrated and never be dispatched again');
    assert.equal(after.commit, before.commit);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.dispatchMetadata, before.dispatchMetadata);
    assert.equal(after.taskRunId, before.taskRunId);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } })).status, 'ready');
    console.log('Only affected execution is requeued; successful sibling commit and evidence remain unchanged');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
