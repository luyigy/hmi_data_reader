import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { inspectPreparationBinding, registerPlatformPreparation, recoverPreparedImplementations } from '../src/lib/task-graph/preparation-recovery';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';
import type { PreparationReceipt } from '../src/lib/task-graph/preparation-contract';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const scratch = await mkdtemp(join(tmpdir(), 'prepared-recovery-'));
  const log = join(scratch, 'validation.log'); await writeFile(log, 'actual validation passed\n');
  const artifact = { path: log, sha256: createHash('sha256').update('actual validation passed\n').digest('hex') };
  const parent = await prisma.task.create({ data: { name: 'Scoped prepared recovery' } });
  const keys = ['AUTO', 'CRASH', 'STALE', 'UNKNOWN', 'BUSINESS', 'BUDGET', 'TAMPER', 'DEPENDENCY', 'UPSTREAM', 'LIVE', 'ENV', 'DEPS', 'USED_FORMAT', 'MULTI'];
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://prepared-recovery', nodes: keys.map(key => ({ key, goal: key, dependsOn: key === 'DEPENDENCY' ? ['UPSTREAM'] : [],
      acceptance: { mode: 'automatic', checks: ['behavior'] }, executions: (key === 'MULTI' ? ['one', 'two'] : ['job']).map(name => ({
        key: name, repository: scratch, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } })) })) } });
  try {
    await releaseReadyNodes(run.id);
    for (const key of keys.filter(key => !['DEPENDENCY', 'UPSTREAM', 'MULTI'].includes(key))) {
      const token = `claim-${key}`;
      await claimNode(run.id, key, token);
      const job = await claimExecution(run.id, key, 'job', token); assert(job);
      const worker = await createGraphWriter();
      const progress = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: 0, outcomeId: 'candidate',
        outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: 'b'.repeat(40), workspaceBase: 'a'.repeat(40), worker } });
      await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: progress.revision, outcomeId: 'blocked',
        outcome: { kind: 'decision_required', failure: { code: key === 'BUSINESS' ? 'missing_business_material' : key === 'ENV' ? 'environment_failed' : 'missing_upstream_input',
          detail: 'Missing immutable upstream package, prepared by platform', ...(key === 'ENV' ? { blockerCause: 'transient' as const } : {}) } } });
      if (key !== 'LIVE') await releaseGraphExecutionWorker(job.id, token, worker.nonce);
      if (key === 'UNKNOWN' || key === 'BUDGET' || key === 'USED_FORMAT') {
        const row = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        const state = executionProgress(row.dispatchMetadata); assert(state);
        if (key === 'UNKNOWN') { delete state.worker; delete state.workerReleasedAt; }
        else if (key === 'BUDGET') { state.platformAttempts = 2; state.state = 'exhausted'; }
        else state.formatAttempts = 1;
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(row.dispatchMetadata, state) } });
      }
    }
    const receipt = async (key: string): Promise<PreparationReceipt> => ({ version: 1, runId: run.id, nodeKey: key, requestId: `prep-${key}`,
      authorization: 'approved-test-operator', changeReason: 'Restored and validated exact missing immutable package', readiness: 'local_operator_attested',
      remediation: 'upstream_binding', bindingHash: await inspectPreparationBinding(run.id, key, 'upstream_binding'), artifacts: [artifact] });
    const auto = await receipt('AUTO');
    const before = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'AUTO' } } });
    const registered = await registerPlatformPreparation(auto);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: before.id } })).status, 'attention', 'Registration alone cannot requeue');
    assert.equal((await registerPlatformPreparation(auto)).eventId, registered.eventId);
    await assert.rejects(registerPlatformPreparation({ ...auto, changeReason: 'different' }), /reused/);
    const crash = await registerPlatformPreparation(await receipt('CRASH'));
    await scheduleImplementationRecovery(run.id, 'CRASH', `prepared:${crash.eventId}`, crash.eventId);
    const stale = await registerPlatformPreparation(await receipt('STALE'));
    const staleJob = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'STALE' } } });
    const staleProgress = executionProgress(staleJob.dispatchMetadata); assert(staleProgress);
    await prisma.taskGraphExecution.update({ where: { id: staleJob.id }, data: { dispatchMetadata: metadataWithProgress(staleJob.dispatchMetadata, { ...staleProgress, revision: staleProgress.revision + 1 }) } });
    await assert.rejects(scheduleImplementationRecovery(run.id, 'STALE', `prepared:${stale.eventId}`, stale.eventId), /Stale preparation/,
      'Expectation is revalidated under original recovery transaction lock, not only during registration');
    await registerPlatformPreparation(await receipt('UNKNOWN'));
    await registerPlatformPreparation(await receipt('USED_FORMAT'));
    await registerPlatformPreparation(await receipt('LIVE'));
    await assert.rejects(receipt('BUSINESS'), /not authorized/);
    await assert.rejects(receipt('BUDGET'), /exhausted/);
    await assert.rejects(inspectPreparationBinding(run.id, 'ENV', 'missing_capability'), /not authorized/);
    const tamper = await receipt('TAMPER');
    const link = join(scratch, 'link.log'); await symlink(log, link);
    await assert.rejects(registerPlatformPreparation({ ...tamper, artifacts: [{ ...artifact, path: link }] }), /non-symlink/);
    const localLog = join(scratch, 'other.log'); await writeFile(localLog, 'separate');
    await registerPlatformPreparation({ ...tamper, artifacts: [{ path: localLog, sha256: createHash('sha256').update('separate').digest('hex') }] });
    await writeFile(localLog, 'changed');
    await prisma.taskGraphNode.update({ where: { runId_key: { runId: run.id, key: 'DEPS' } }, data: { dependsOn: ['UPSTREAM'] } });
    await assert.rejects(receipt('DEPS'), /dependencies have not passed/);
    await recoverPreparedImplementations(run.id);
    await recoverPreparedImplementations(run.id);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(after.status, 'ready');
    const usedFormat = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'USED_FORMAT' } } });
    assert.equal(usedFormat.status, 'ready');
    assert.equal(executionProgress(usedFormat.dispatchMetadata)?.formatAttempts, 1, 'Used unrelated format budget cannot block a prepared implement recovery or be reset');
    const previousProgress = executionProgress(before.dispatchMetadata), nextProgress = executionProgress(after.dispatchMetadata); assert(previousProgress && nextProgress);
    for (const key of ['repairAttempts', 'platformAttempts', 'formatAttempts', 'integrationAttempts', 'candidateCommit', 'workspaceBase'] as const) assert.equal(nextProgress[key], previousProgress[key]);
    for (const key of ['STALE', 'UNKNOWN', 'LIVE', 'TAMPER']) assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key } } })).status, 'attention', `${key} cannot be resumed`);
    const consumed = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: run.id, idempotencyKey: `preparation-consumed:${crash.eventId}` } });
    assert.equal(Reflect.get(Object(consumed.payload), 'kind'), 'already_scheduled', 'Crash after schedule reconciles existing event, no second dispatch');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'implementation_recovery_scheduled' } }), 3);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'UPSTREAM' } } })).status, 'ready', 'Unrelated frontier untouched');
    await prisma.taskGraphNode.updateMany({ where: { runId: run.id, key: { in: ['DEPENDENCY', 'MULTI'] } }, data: { status: 'attention' } });
    await assert.rejects(inspectPreparationBinding(run.id, 'MULTI', 'upstream_binding'), /exactly one/);
    console.log('Prepared receipts automatically requeue only exact approved pauses; stale, unknown/live writers, budgets, business failures and changed artifacts stay protected; crash replay uses original scheduling receipt');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect(); await rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
