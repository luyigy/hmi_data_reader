import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, claimNode, claimExecution, completeExecution, releaseReadyNodes, flagStaleExecutionClaim } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { pauseGraphImplementation, scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'legacy adapter fences' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://adapter-boundaries', nodes: ['COMPLETE', 'RESUME', 'RESUME_OK', 'RECLASS', 'STALE'].map(key => ({
      key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['behavior'] },
      executions: [{ key: 'job', repository: '/tmp/adapter-fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40),
        agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } }],
    })),
  } });
  try {
    await releaseReadyNodes(run.id);
    for (const key of ['COMPLETE', 'RESUME', 'RESUME_OK', 'RECLASS', 'STALE']) {
      const token = `claim-${key}`;
      await claimNode(run.id, key, token);
      const job = await claimExecution(run.id, key, 'job', token); assert(job);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { worktreePath: `/tmp/adapter-${job.id}`, worktreeBranch: `refs/heads/adapter-${job.id}` } });
      const progress = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: 0, outcomeId: 'implement',
        outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: job.baseCommit, candidateCommit: 'b'.repeat(40), worker: await createGraphWriter() } });
      if (key === 'COMPLETE') {
        await assert.rejects(completeExecution({ runId: run.id, nodeKey: key, executionKey: 'job', claimToken: token,
          commit: 'b'.repeat(40), evidence: { checks: [] } }), /phase|阶段/i,
        'Legacy completion API must not integrate a versioned execution before its integration phase');
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'claimed');
      } else if (key === 'RESUME') {
        await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: progress.revision, outcomeId: 'ownership',
          outcome: { kind: 'decision_required', failure: { code: 'ownership_mismatch', detail: 'Recorded branch changed; reconciliation required' } } });
        await assert.rejects(scheduleImplementationRecovery(run.id, key, 'ordinary-continue'), /ownership|归属/i,
          'An ordinary continue must not reopen an unresolved ownership mismatch');
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention');
      } else if (key === 'STALE') {
        await assert.rejects(flagStaleExecutionClaim({ runId: run.id, nodeKey: key, executionKey: 'job', claimToken: token,
          claimedBefore: new Date(Date.now() + 60_000) }), /writer ownership proof/);
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'claimed');
      } else if (key === 'RECLASS') {
        const integrating = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: progress.revision,
          outcomeId: 'integrate', outcome: { kind: 'checkpoint', phase: 'integrate' } });
        const delivered = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: integrating.revision,
          outcomeId: 'delivered', outcome: { kind: 'integrated', commit: 'c'.repeat(40), evidence: { preserved: true } } });
        await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'delivered_unverified' } });
        const corrected = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: delivered.revision,
          outcomeId: 'reclassified', outcome: { kind: 'delivery_reclassified', authorization: 'audited-operator-correction',
            failure: { code: 'missing_business_material', detail: 'Original delivery was incomplete' } } });
        assert.equal(corrected.phase, 'implement'); assert.equal(corrected.state, 'waiting_decision');
        assert.equal(corrected.candidateCommit, 'c'.repeat(40));
        const owner = await createGraphWriter();
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(null, { ...corrected, worker: owner }) } });
        await releaseGraphExecutionWorker(job.id, token, owner.nonce);
        await scheduleImplementationRecovery(run.id, key, 'explicit-resume');
        const resumed = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        assert.equal(resumed.status, 'ready'); assert.equal(resumed.commit, 'c'.repeat(40));
        assert.deepEqual(resumed.evidence, { preserved: true });
      } else {
        await pauseGraphImplementation({ executionId: job.id, runId: run.id, nodeKey: key, claimToken: token,
          checkpointCommit: 'd'.repeat(40), workspaceBase: 'e'.repeat(40), taskRunId: 'not-created',
          result: { status: 'blocked', blockerKind: 'scope_change', note: 'Scope now clarified' } });
        const blocked = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata); assert(blocked);
        assert.equal(blocked.workspaceBase, job.baseCommit, 'A stale adapter base cannot overwrite the authoritative workspace base');
        assert(blocked.worker);
        await releaseGraphExecutionWorker(job.id, token, blocked.worker.nonce);
        const released = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata); assert(released);
        const firstReceipt = await scheduleImplementationRecovery(run.id, key, 'authorized-continue');
        const repeatReceipt = await scheduleImplementationRecovery(run.id, key, 'authorized-continue');
        assert.equal(firstReceipt.kind, 'scheduled'); assert.equal(repeatReceipt.kind, 'already_scheduled');
        assert.equal(firstReceipt.eventId, repeatReceipt.eventId, 'Repeating a request returns the original receipt, not a claim of another dispatch');
        const resumed = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        const next = executionProgress(resumed.dispatchMetadata); assert(next);
        assert.equal(resumed.status, 'ready'); assert.equal(next.revision, released.revision + 1);
        assert.equal(next.candidateCommit, blocked.candidateCommit); assert.equal(next.repairAttempts, blocked.repairAttempts);
        assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'execution_outcome',
          idempotencyKey: { contains: 'operator-resume:' } } }), 1);
        await claimNode(run.id, key, 'later-node-claim');
        const laterWriter = await createGraphWriter();
        const later = await claimExecution(run.id, key, 'job', 'later-job-claim', undefined, laterWriter); assert(later);
        const laterProgress = executionProgress(later.dispatchMetadata); assert(laterProgress);
        await applyExecutionOutcome({ executionId: job.id, claimToken: 'later-job-claim', expectedRevision: laterProgress.revision,
          outcomeId: 'later-block', outcome: { kind: 'decision_required', failure: { code: 'scope_change', detail: 'New independent scope question' } } });
        const oldRequest = await scheduleImplementationRecovery(run.id, key, 'authorized-continue');
        assert.equal(oldRequest.kind, 'already_scheduled'); assert.equal(oldRequest.eventId, firstReceipt.eventId);
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention',
          'A consumed request must not requeue a later pause, even when the new phase writer is still alive');
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
