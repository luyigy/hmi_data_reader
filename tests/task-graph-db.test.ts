import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes, recordExecutionDispatch,
  completeExecution, markNodeIntegrationsReady, completeUnverifiedNode, submitNodeVerification, refreshTaskGraphRunStatus } from '../src/lib/task-graph/store';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  const id = randomUUID();
  const parent = await prisma.task.create({ data: { name: `task-graph-db-test-${id}` } });
  const definition: GraphDefinition = { specRef: `test://${id}`, nodes: [
    { key: 'V1', goal: 'Smoke test', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
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
    await assert.rejects(() => completeUnverifiedNode(run.id, 'V1'), /must be integrated/);
    for (const key of ['V1', 'V2']) {
      if (key === 'V2') {
        await claimNode(run.id, key, id);
        await claimExecution(run.id, key, 'api', id);
      }
      await recordExecutionDispatch({ runId: run.id, nodeKey: key, executionKey: 'api', claimToken: id,
        worktreePath: `/tmp/workflow-test-${id}/${key}`, worktreeBranch: `task-test/${id}/${key}` });
      await completeExecution({ runId: run.id, nodeKey: key, executionKey: 'api', claimToken: id,
        commit: 'b'.repeat(40), evidence: { fixture: 'isolated database state test' } });
      await markNodeIntegrationsReady(run.id, key);
      if (key === 'V1') {
        assert.equal((await completeUnverifiedNode(run.id, key)).status, 'delivered_unverified');
        assert.equal((await completeUnverifiedNode(run.id, key)).status, 'delivered_unverified');
        assert.deepEqual(await releaseReadyNodes(run.id), ['V2']);
        assert.deepEqual(await releaseReadyNodes(run.id), []);
      } else {
        await assert.rejects(() => completeUnverifiedNode(run.id, key), /approved implement-only/);
        await submitNodeVerification({ runId: run.id, nodeKey: key, actorId: 'system', evidence: {
          summary: 'Smoke evidence', checks: [{ name: 'smoke', passed: true, evidence: 'fixture passed' }],
        } });
      }
    }
    const recovered = nodes.find((node) => node.key === 'V2')!;
    await prisma.taskGraphNode.update({ where: { id: recovered.id }, data: { status: 'verifying' } });
    await submitNodeVerification({ runId: run.id, nodeKey: 'V2', actorId: 'system', attempt: 'recovery:test', evidence: {
      summary: 'Recovered evidence', checks: [{ name: 'smoke', passed: true, evidence: 'recovery passed' }],
    } });
    assert.ok(await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
      runId: run.id, idempotencyKey: 'node:V2:verified:recovery:test',
    } } }));
    assert.equal((await refreshTaskGraphRunStatus(run.id)).status, 'completed_unverified');
    console.log('Task graph PostgreSQL persistence checks passed');
  } finally {
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
