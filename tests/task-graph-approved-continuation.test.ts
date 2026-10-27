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
import { receiveGraphTaskMessage, conversationInputs } from '../src/lib/task-graph/conversation-inbox';

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
    for (const source of ['conversation', 'materials'] as const) {
      await check(`retired ${source} wake cannot change state, permissions or budgets`, async () => {
        const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        const result = await admitNode(job.nodeId, source === 'conversation'
          ? { source, id: 'old-chat', executionIds: [job.id], inputIds: (await conversationInputs(job.id)).map(item => item.id) }
          : { source, id: 'old-handoff', executionIds: [job.id], reservationId: 'forged', expectedRevision: saved.revision });
        assert.deepEqual(result, { kind: 'rejected', reason: 'legacy_conversation_admission_retired' });
        assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), before);
      });
    }
    for (const code of ['permission_required', 'scope_change', 'agent_capability_missing', 'resource_application_failed']) {
      await check(`automatic polling retains ${code} hold`, async () => {
        await reset({ state: 'waiting_decision', lastFailure: { code, detail: 'approval or repair required' } });
        assert.equal((await admitNode(job.nodeId, { source: 'conditions', id: `poll-${code}` })).kind, 'deferred');
      });
    }
    await check('historical ordinary question is known while an unrelated wait stays unknown', async () => {
      await reset({ state: 'active', lastFailure: { code: 'permission_required', detail: 'stale' } }, 'claimed');
      const p = await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: saved.revision + 10,
        outcomeId: 'historical-question', outcome: { kind: 'waiting_for_user', note: 'which value?', result: 'question' } });
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal((await currentWaitCause(current, p))?.requiresUserDecision, false);
      assert.equal((await currentWaitCause(current, { ...p, lastFailure: { code: 'permission_required', detail: 'stale legacy residue' } }))?.requiresUserDecision, false, 'A recorded ordinary question overrides stale legacy display fields');
      assert.equal(await currentWaitCause(current, { ...p, revision: p.revision + 20 }), null, 'Do not reuse a previous waiting round');
      assert.equal(await currentWaitCause({ ...current, claimToken: 'different-owner' }, p), null);
      assert.equal(await currentWaitCause(current, { ...p, candidateCommit: 'b'.repeat(40) }), null);
      assert.equal(await currentWaitCause(current, { ...p, phase: 'acceptance' }), null);
      assert.equal(await currentWaitCause(current, { ...p, taskRunId: 'other-run' }), null);

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
