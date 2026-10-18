import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { prisma } from '../src/lib/prisma';
import { applyExecutionOutcome, executionProgress, type ExecutionOutcomeRequest } from '../src/lib/task-graph/execution-progress';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes, recordExecutionDispatch } from '../src/lib/task-graph/store';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  for (const progress of [{}, { version: 2 }, { version: 1, revision: -1 },
    { version: 1, revision: 0, phase: 'bogus', state: 'ready', repairAttempts: 0, formatAttempts: 0, platformAttempts: 0 }]) {
    assert.throws(() => executionProgress({ progress }));
  }
  const parent = await prisma.task.create({ data: { name: `progress-${randomUUID()}` } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://progress', nodes: ['A', 'B', 'ORPHAN'].map(key => ({ key, goal: key, dependsOn: [], executionMode: 'implement' as const,
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/progress-fixture',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] })),
  } });
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'A', 'first');
    const job = await claimExecution(run.id, 'A', 'repo', 'first'); assert.ok(job);
    const dispatch = { runId: run.id, nodeKey: 'A', executionKey: 'repo', claimToken: 'first',
      dispatchMetadata: { integrationRef: 'refs/heads/fixture', workspaceBase: 'a'.repeat(40) } };
    await recordExecutionDispatch(dispatch);
    await assert.rejects(applyExecutionOutcome({ executionId: job.id, claimToken: 'first', expectedRevision: 0,
      outcomeId: 'wrong-phase', outcome: { kind: 'integrated', commit: 'c'.repeat(40), evidence: {} } }), /current phase/);
    const checkpoint = { executionId: job.id, claimToken: 'first', expectedRevision: 0, outcomeId: 'candidate',
      outcome: { kind: 'checkpoint' as const, phase: 'check' as const, candidateCommit: 'b'.repeat(40), workspaceBase: 'a'.repeat(40) } };
    const progress = await applyExecutionOutcome(checkpoint); assert.equal(progress.revision, 1);
    assert.deepEqual(await applyExecutionOutcome(checkpoint), progress, 'Outcome redelivery is idempotent');
    await recordExecutionDispatch(dispatch);
    assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.revision, 1, 'Repeated dispatch retains progress');
    await assert.rejects(applyExecutionOutcome({ ...checkpoint, outcomeId: 'stale', outcome: { ...checkpoint.outcome, candidateCommit: 'c'.repeat(40) } }), /revision mismatch/);
    const retry = { executionId: job.id, claimToken: 'first', expectedRevision: 1, outcomeId: 'format',
      outcome: { kind: 'result_incomplete' as const, failure: { code: 'invalid_result', detail: 'missing conclusion' } } };
    const waiting = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'waiting_for_input' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: waiting.id } });
    await assert.rejects(applyExecutionOutcome(retry), /live TaskRun/);
    assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.revision, 1);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: null } });
    await prisma.taskRun.delete({ where: { id: waiting.id } });
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
    await claimNode(run.id, 'B', 'integration');
    const integration = await claimExecution(run.id, 'B', 'repo', 'integration'); assert.ok(integration);
    await applyExecutionOutcome({ executionId: integration.id, claimToken: 'integration', expectedRevision: 0,
      outcomeId: 'integration-start', outcome: { kind: 'checkpoint', phase: 'integrate', candidateCommit: 'd'.repeat(40) } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stale: ExecutionOutcomeRequest = { executionId: integration.id, claimToken: 'integration', expectedRevision: attempt,
        outcomeId: `stale-${attempt}`, outcome: { kind: 'integration_stale' as const, failure: { code: 'integration_stale', detail: 'CAS reference advanced' } } };
      const progress = await applyExecutionOutcome(stale);
      assert.equal(progress.integrationAttempts, attempt);
      assert.equal(progress.state, attempt < 3 ? 'active' : 'exhausted');
      assert.deepEqual(await applyExecutionOutcome(stale), progress);
    }
    const final = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: integration.id } });
    assert.equal(final.issueKind, 'retry_exhausted'); assert.equal(final.commit, null);
    await claimNode(run.id, 'ORPHAN', 'orphan');
    const orphanJob = await claimExecution(run.id, 'ORPHAN', 'repo', 'orphan'); assert(orphanJob);
    await applyExecutionOutcome({ executionId: orphanJob.id, claimToken: 'orphan', expectedRevision: 0, outcomeId: 'implement', outcome: { kind: 'checkpoint', phase: 'implement' } });
    const writer = await createGraphWriter();
    const finishedRun = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'completed', controlMetadata: JSON.stringify({ graphWriter: writer }),
      participants: { create: [{ gatewayId: 'platform-local', gatewayNameSnapshot: 'Local', executionBackend: 'platform_local', harnessType: 'codex', harnessNameSnapshot: 'Codex', role: 'implementer', runner: 'codex', status: 'completed' }] } } });
    await prisma.taskGraphExecution.update({ where: { id: orphanJob.id }, data: { taskRunId: finishedRun.id } });
    await releaseTaskRunWriter(finishedRun.id, writer.nonce);
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: ['ignore', 'pipe', 'pipe'] });
    const requeue: ExecutionOutcomeRequest = { executionId: orphanJob.id, claimToken: 'orphan', expectedRevision: 1, outcomeId: 'retry', outcome: { kind: 'platform_retry', failure: { code: 'environment_failed', detail: 'Retry after native cleanup' } } };
    try {
      await once(child.stdout, 'data');
      await assert.rejects(applyExecutionOutcome(requeue), /actual writer exit proof/);
      assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: orphanJob.id } })).status, 'claimed');
    } finally { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    assert.equal((await applyExecutionOutcome(requeue)).platformAttempts, 1);
    await prisma.taskRun.delete({ where: { id: finishedRun.id } });
    console.log('Durable outcomes: revision/token fencing, duplicate budgets, immutable dispatch, candidate retention and explicit exhausted state');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: parent.id } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
