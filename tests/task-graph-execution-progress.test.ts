import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { applyExecutionOutcome, executionProgress } from '../src/lib/task-graph/execution-progress';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes, recordExecutionDispatch } from '../src/lib/task-graph/store';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: `progress-${randomUUID()}` } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://progress', nodes: [{ key: 'A', goal: 'A', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/progress-fixture',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }],
  } });
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'A', 'first');
    const job = await claimExecution(run.id, 'A', 'repo', 'first'); assert.ok(job);
    const dispatch = { runId: run.id, nodeKey: 'A', executionKey: 'repo', claimToken: 'first',
      dispatchMetadata: { integrationRef: 'refs/heads/fixture', workspaceBase: 'a'.repeat(40) } };
    await recordExecutionDispatch(dispatch);
    const checkpoint = { executionId: job.id, claimToken: 'first', expectedRevision: 0, outcomeId: 'candidate',
      outcome: { kind: 'checkpoint' as const, phase: 'check' as const, candidateCommit: 'b'.repeat(40), workspaceBase: 'a'.repeat(40) } };
    const progress = await applyExecutionOutcome(checkpoint); assert.equal(progress.revision, 1);
    assert.deepEqual(await applyExecutionOutcome(checkpoint), progress, 'Outcome redelivery is idempotent');
    await recordExecutionDispatch(dispatch);
    assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.revision, 1, 'Repeated dispatch retains progress');
    await assert.rejects(applyExecutionOutcome({ ...checkpoint, outcomeId: 'stale', outcome: { ...checkpoint.outcome, candidateCommit: 'c'.repeat(40) } }), /revision mismatch/);
    const retry = { executionId: job.id, claimToken: 'first', expectedRevision: 1, outcomeId: 'format',
      outcome: { kind: 'result_incomplete' as const, failure: { code: 'invalid_result', detail: 'missing conclusion' } } };
    assert.equal((await applyExecutionOutcome(retry)).formatAttempts, 1);
    assert.equal((await applyExecutionOutcome(retry)).formatAttempts, 1);
    const collected = await claimExecution(run.id, 'A', 'repo', 'second'); assert.ok(collected);
    await assert.rejects(applyExecutionOutcome({ ...retry, outcomeId: 'old-worker', expectedRevision: 2 }), /ownership/);
    assert.equal((await applyExecutionOutcome({ ...retry, outcomeId: 'invalid-again', claimToken: 'second', expectedRevision: 2 })).state, 'exhausted');
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(current.status, 'attention'); assert.equal(current.issueKind, 'retry_exhausted');
    assert.equal(executionProgress(current.dispatchMetadata)?.candidateCommit, 'b'.repeat(40));
    assert.equal(current.commit, null, 'Saving candidate does not publish an integration');
    await assert.rejects(scheduleImplementationRecovery(run.id, 'A', 'ordinary-continue'), /耗尽/);
    assert.equal(await claimExecution(run.id, 'A', 'repo', 'third'), null);
    console.log('Durable outcomes: revision/token fencing, duplicate budgets, immutable dispatch, candidate retention and explicit exhausted state');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: parent.id } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
