import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { claimExecution, claimNode, createTaskGraphRun, recordExecutionIssue, releaseReadyNodes } from '../src/lib/task-graph/store';

async function main() {
  const parent = await prisma.task.create({ data: { name: `startup-retry-${randomUUID()}` } });
  try {
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id,
      definition: { specRef: 'frozen', nodes: [{ key: 'S03', goal: 'Deliver', dependsOn: [], executionMode: 'implement',
        acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'mold', instructions: 'Implement',
          repository: '/data1/code/example', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }] }] } });
    await releaseReadyNodes(run.id);
    for (const token of ['first', 'retry']) {
      assert.ok(await claimNode(run.id, 'S03', token));
      const execution = await claimExecution(run.id, 'S03', 'mold', token);
      assert.ok(execution);
      await recordExecutionIssue({ runId: run.id, nodeKey: 'S03', executionKey: 'mold', claimToken: token,
        kind: 'dispatch_failed', detail: `Startup failed ${token}` });
      if (token === 'first') {
        // Model an operator-authorized reset after confirming no model or tool execution occurred.
        await prisma.taskGraphNode.update({ where: { id: execution.nodeId }, data: { status: 'ready', claimToken: null, claimedAt: null } });
        await prisma.taskGraphExecution.update({ where: { id: execution.id }, data: { status: 'ready', claimToken: null, claimedAt: null } });
      }
    }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'dispatch_failed' } }), 2);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'execution_claimed' } }), 2);
    console.log('Explicit startup retry preserves both attempts and their issue events');
  } finally {
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
