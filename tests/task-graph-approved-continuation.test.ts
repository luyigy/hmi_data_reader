import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { pauseGraphImplementation } from '../src/lib/task-graph/implementation-result';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { admitNode } from '../src/lib/task-graph/preparation-recovery';
import { currentWaitCause } from '../src/lib/task-graph/waiting-cause';
import { receiveGraphTaskMessage, handoffConversationMaterials, conversationInputs } from '../src/lib/task-graph/conversation-inbox';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'approved-continuation-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  await writeFile(path.join(root, 'base'), 'base'); git('add', 'base'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const owner = await prisma.user.create({ data: { username: root, passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'approved continuation', ownerUserId: owner.id } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'fixture://approved', nodes: [{ key: 'A', goal: 'saved work', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: root, gitRef: 'refs/heads/main',
        baseCommit: baseline, agentSelector: 'local:codex', instructions: 'approved scope' }] }] } });
  const failures: string[] = [];
  async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, error); }
  }
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'A', 'claim');
    const job = await claimExecution(run.id, 'A', 'repo', 'claim'); assert(job);
    const child = await prisma.task.create({ data: { name: 'saved agent', ownerUserId: owner.id } });
    const workspace = path.join(root, 'work'); git('worktree', 'add', '--detach', workspace, baseline);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: workspace, worktreeBranch: 'refs/heads/work' } });
    const worker = await createGraphWriter();
    await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: 0, outcomeId: 'checkpoint',
      outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: baseline, workspaceBase: baseline, worker } });
    await pauseGraphImplementation({ runId: run.id, nodeKey: 'A', executionId: job.id, claimToken: 'claim', checkpointCommit: baseline,
      workspaceBase: baseline, taskRunId: 'fixture', result: { status: 'blocked', blockerKind: 'permission_required', note: 'new directory requires approval' } });
    await check('permission cause survives the real implementation outcome', async () => {
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(executionProgress(current.dispatchMetadata)?.lastFailure?.code, 'permission_required');
      assert.equal(executionProgress(current.dispatchMetadata)?.lastFailure?.requiresUserDecision, true);
    });
    await releaseGraphExecutionWorker(job.id, 'claim', worker.nonce);
    const waiting = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const saved = executionProgress(waiting.dispatchMetadata)!;
    const reset = async (overrides: Partial<typeof saved> = {}, status = 'attention') => {
      await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
      const progress = { ...saved, revision: saved.revision + 10, ...overrides };
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status, claimToken: 'claim',
        dispatchMetadata: metadataWithProgress(waiting.dispatchMetadata, progress) } });
      await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: job.nodeId, kind: 'execution_outcome', idempotencyKey: randomUUID(),
        payload: { executionId: job.id, claimToken: 'claim', outcome: progress.lastFailure
          ? { kind: 'decision_required', failure: progress.lastFailure } : { kind: 'waiting_for_user', note: 'legacy unclassified wait' }, progress } } });
    }
    await check('admission clears old wait cause and display without resetting budgets', async () => {
      await reset({ lastFailure: { code: 'permission_required', detail: 'old', requiresUserDecision: true }, platformAttempts: 19 });
      assert.equal((await admitNode(job.nodeId, { source: 'operator', id: 'operator' })).kind, 'admitted');
      const p = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)!;
      assert.equal(p.lastFailure, undefined); assert.equal(p.waitingKind, undefined); assert.equal(p.waitingMessage, undefined); assert.equal(p.platformAttempts, 19);
    });
    await check('ordinary question clears a previous permission cause', async () => {
      await reset({ state: 'active', lastFailure: { code: 'permission_required', detail: 'old' } }, 'claimed');
      const p = await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: saved.revision + 10,
        outcomeId: 'ordinary-question', outcome: { kind: 'waiting_for_user', note: 'which value?' } });
      assert.equal(p.lastFailure, undefined);
    });
    await check('operator continues check phase instead of restarting implementation', async () => {
      await reset({ phase: 'check', state: 'waiting_decision', lastFailure: { code: 'environment_failed', detail: 'retry' } });
      assert.equal((await admitNode(job.nodeId, { source: 'operator', id: 'check' })).kind, 'admitted');
      assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.phase, 'check');
    });
    const input = await receiveGraphTaskMessage({ taskId: child.id, actorId: owner.id, actorOrigin: 'platform', sourceId: 'answer', content: 'continue approved work' });
    assert(input);
    const reservation = async (id: string, failure: typeof saved.lastFailure) => {
      await reset({ state: 'waiting_decision', lastFailure: failure, waitingKind: 'question', conversation: { kind: 'reserved', reservationId: id } });
      await prisma.taskGraphEvent.create({ data: { id, runId: run.id, nodeId: job.nodeId, kind: 'conversation_followup_reserved',
        idempotencyKey: id, payload: { executionId: job.id, inputIds: (await conversationInputs(job.id)).map(item => item.id), worker } } });
      return handoffConversationMaterials({ executionId: job.id, reservationId: id, expectedRevision: saved.revision + 10 });
    }
    await check('model handoff accepts known nondecision work despite question label', async () => {
      const result = await reservation('known-work', { code: 'test_failed', detail: 'fix test', requiresUserDecision: false });
      assert.equal(result.kind, 'admitted', JSON.stringify(result));
    });
    await check('model handoff rejects unknown waiting cause', async () => {
      const result = await reservation('unknown-work', undefined);
      assert.equal('reason' in result && result.reason, 'unknown_wait_cause');
    });
    await check('model handoff cannot treat unresolved decision as material', async () => {
      const result = await reservation('decision-work', { code: 'missing_business_material', detail: 'choose business option', requiresUserDecision: true });
      assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'human_input_required');
    });
    await check('direct handoff requires its persisted reservation', async () => {
      await reset({ state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: 'material' }, conversation: { kind: 'reserved', reservationId: 'forged' } });
      const result = await handoffConversationMaterials({ executionId: job.id, reservationId: 'forged', expectedRevision: saved.revision + 10 });
      assert.equal(result.kind, 'deferred');
    });
    await check('unknown cause permits authenticated ordinary user input', async () => {
      await reset({ state: 'waiting_for_user', lastFailure: undefined });
      const inputs = await conversationInputs(job.id);
      const result = await admitNode(job.nodeId, { source: 'conversation', id: 'ordinary-unknown', executionIds: [job.id], inputIds: inputs.map(input => input.id) });
      assert.equal(result.kind, 'admitted', JSON.stringify(result));
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(current.status, 'ready'); assert.equal(current.worktreePath, workspace);
      assert.equal((await conversationInputs(job.id)).length, inputs.length, 'Admission alone does not consume input');
    });
    for (const code of ['permission_required', 'scope_change', 'resource_application_failed', 'agent_capability_missing']) {
      await check(`ordinary conversation cannot approve ${code}`, async () => {
        await reset({ state: 'waiting_decision', lastFailure: { code, detail: 'approval still required' } });
        const inputs = await conversationInputs(job.id);
        const result = await admitNode(job.nodeId, { source: 'conversation', id: `unapproved-${code}`, executionIds: [job.id], inputIds: inputs.map(input => input.id) });
        assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'human_input_required');
        assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention');
      });
    }
    await check('ordinary conversation cannot start acceptance', async () => {
      await reset({ phase: 'acceptance', state: 'exhausted', lastFailure: undefined });
      const result = await admitNode(job.nodeId, { source: 'conversation', id: 'not-a-review-approval', executionIds: [job.id], inputIds: (await conversationInputs(job.id)).map(input => input.id) });
      assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'implementation_phase_required');
    });
    await check('ordinary input cannot start a second live writer', async () => {
      await reset({ lastFailure: undefined, worker: await createGraphWriter(), workerReleasedAt: undefined });
      const result = await admitNode(job.nodeId, { source: 'conversation', id: 'live-input', executionIds: [job.id], inputIds: (await conversationInputs(job.id)).map(input => input.id) });
      assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'writer_not_exited');
    });
    await check('repeated ordinary admission creates one schedule', async () => {
      await reset({ revision: saved.revision + 20, lastFailure: undefined });
      const wake = { source: 'conversation' as const, id: 'concurrent-input', executionIds: [job.id], inputIds: (await conversationInputs(job.id)).map(input => input.id) };
      const results = await Promise.all([admitNode(job.nodeId, wake), admitNode(job.nodeId, wake)]);
      assert.equal(results.filter(result => result.kind === 'admitted').length, 1);
      assert.equal(results.filter(result => result.kind === 'already_scheduled').length, 1);
    });
    await check('ordinary input cannot resume an explicitly paused graph', async () => {
      await reset({ lastFailure: undefined });
      const inputIds = (await conversationInputs(job.id)).map(input => input.id);
      await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'paused' } });
      try {
        const result = await admitNode(job.nodeId, { source: 'conversation', id: 'paused-input', executionIds: [job.id], inputIds });
        assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'run_paused_or_complete');
      } finally { await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'running' } }); }
    });
    await check('conversation wake without user input is not authorization', async () => {
      await reset({ lastFailure: undefined });
      const result = await admitNode(job.nodeId, { source: 'conversation', id: 'empty-user-wake', executionIds: [job.id], inputIds: [] });
      assert.equal(result.kind, 'deferred');
    });
    await check('reservation cannot survive an explicit run pause', async () => {
      await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'paused' } });
      try {
        const result = await reservation('paused-work', { code: 'test_failed', detail: 'retry', requiresUserDecision: false });
        assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'run_paused_or_complete');
      } finally { await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'running' } }); }
    });
    await check('reservation cannot admit a changed revision', async () => {
      await reset({ conversation: { kind: 'reserved', reservationId: 'revision-drift' } });
      const result = await handoffConversationMaterials({ executionId: job.id, reservationId: 'revision-drift', expectedRevision: saved.revision + 9 });
      assert.equal(result.kind, 'deferred'); assert.equal('reason' in result && result.reason, 'material_reservation_changed');
    });
    await check('historical ordinary question is known while an unrelated wait stays unknown', async () => {
      await reset({ state: 'active', lastFailure: { code: 'permission_required', detail: 'stale' } }, 'claimed');
      const p = await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: saved.revision + 10,
        outcomeId: 'historical-question', outcome: { kind: 'waiting_for_user', note: 'which value?', result: 'question' } });
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal((await currentWaitCause(current, p))?.requiresUserDecision, false);
      assert.equal((await currentWaitCause(current, { ...p, lastFailure: { code: 'permission_required', detail: 'stale legacy residue' } }))?.requiresUserDecision, false, 'A recorded ordinary question overrides stale legacy display fields');
      assert.equal(await currentWaitCause(current, { ...p, revision: p.revision + 20 }), null, 'Do not reuse a previous waiting round');
    });
    await check('old outcome without cause is unknown, never an implicit ordinary question', async () => {
      await reset({ state: 'active', lastFailure: undefined }, 'claimed');
      const p = await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: saved.revision + 10,
        outcomeId: 'old-unclassified-wait', outcome: { kind: 'waiting_for_user', note: 'unclassified' } });
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(await currentWaitCause(current, p), null);
    });
    assert.deepEqual(failures, [], 'All approved continuation contracts must pass');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
