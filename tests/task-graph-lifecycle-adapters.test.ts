import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, claimNode, claimExecution, completeExecution, releaseReadyNodes } from '../src/lib/task-graph/store';
import { applyExecutionOutcome } from '../src/lib/task-graph/execution-progress';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'legacy adapter fences' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://adapter-boundaries', nodes: ['COMPLETE', 'RESUME'].map(key => ({
      key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['behavior'] },
      executions: [{ key: 'job', repository: '/tmp/adapter-fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40),
        agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } }],
    })),
  } });
  try {
    await releaseReadyNodes(run.id);
    for (const key of ['COMPLETE', 'RESUME']) {
      const token = `claim-${key}`;
      await claimNode(run.id, key, token);
      const job = await claimExecution(run.id, key, 'job', token); assert(job);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { worktreePath: `/tmp/adapter-${job.id}`, worktreeBranch: `refs/heads/adapter-${job.id}` } });
      const progress = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: 0, outcomeId: 'implement',
        outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: job.baseCommit, candidateCommit: 'b'.repeat(40) } });
      if (key === 'COMPLETE') {
        await assert.rejects(completeExecution({ runId: run.id, nodeKey: key, executionKey: 'job', claimToken: token,
          commit: 'b'.repeat(40), evidence: { checks: [] } }), /phase|阶段/i,
        'Legacy completion API must not integrate a versioned execution before its integration phase');
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'claimed');
      } else {
        await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: progress.revision, outcomeId: 'ownership',
          outcome: { kind: 'decision_required', failure: { code: 'ownership_mismatch', detail: 'Recorded branch changed; reconciliation required' } } });
        await assert.rejects(scheduleImplementationRecovery(run.id, key, 'ordinary-continue'), /ownership|归属/i,
          'An ordinary continue must not reopen an unresolved ownership mismatch');
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention');
      }
    }
    console.log('Legacy completion and ordinary recovery honor versioned phase and ownership boundaries');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
