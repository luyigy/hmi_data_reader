import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { recoverGraphExecution, recoverGraphReview } from '../src/lib/task-graph/restart-recovery';
import { reclassifyIncompleteDelivery } from '../src/lib/task-graph/reclassify-delivery';
import { reserveGraphReviewClaim } from '../src/lib/task-graph/review-ownership';
import { admitNode } from '../src/lib/task-graph/preparation-recovery';
import { initialExecutionProgress, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { exitedGraphWriter } from './fixtures/exited-graph-writer';
import { contend } from './fixtures/graph-lock-rendezvous';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-lock-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(root, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  const commit = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const admin = process.env.FEISHU_ADMIN_OPEN_ID; process.env.FEISHU_ADMIN_OPEN_ID = 'lock-admin';
  const departed = await exitedGraphWriter();
  const cases = ['workspace', 'retry', 'blocked', 'question', 'answered', 'review-ready', 'review-running', 'reclassify-review', 'reclassify-admission'] as const;
  const failures: string[] = [];
  try {
    for (const { kind, paused } of cases.flatMap(kind => [{ kind, paused: false }, { kind, paused: true }])) {
      const review = kind.startsWith('review-'), reclassify = kind.startsWith('reclassify-');
      const parent = await prisma.task.create({ data: { name: `lock ${kind}` } });
      const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
        specRef: 'fixture://recovery-lock', nodes: ['A', 'B', 'C'].map(key => ({ key, goal: key, dependsOn: key === 'B' ? ['A'] : [],
          executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: root,
            gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture' }] })) } });
      const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true }, orderBy: { key: 'asc' } });
      const [node, successor, sibling] = nodes, job = node.executions[0], siblingJob = sibling.executions[0];
      const completed = ['blocked', 'question', 'answered'].includes(kind);
      const summary = 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify(kind === 'blocked'
        ? { status: 'blocked', blockerKind: 'environment_failed', note: 'saved failure' }
        : { status: kind === 'answered' ? 'answered' : 'waiting_for_user', note: 'saved question' });
      const turn = await prisma.taskRun.create({ data: { taskId: parent.id, status: completed || reclassify ? 'completed' : 'running',
        summary, controlMetadata: JSON.stringify({ graphWriter: departed }), participants: { create: {
          executionBackend: 'platform_local', gatewayNameSnapshot: 'local', harnessType: 'codex', role: 'implementer',
          status: completed || reclassify ? 'completed' : 'running', summary, controlMetadata: JSON.stringify({ nativeSessionId: 'native-original' }) } } } });
      const claimKey = `review:${kind}`;
      await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'running' } });
      await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: reclassify ? 'delivered_unverified' : review ? 'verifying' : 'claimed' } });
      await prisma.taskGraphNode.update({ where: { id: successor.id }, data: { status: 'ready' } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: review || reclassify ? 'integrated' : 'claimed',
        childTaskId: parent.id, taskRunId: review ? null : turn.id, claimToken: 'original-claim', commit: review || reclassify ? commit : null,
        ...(kind === 'workspace' ? { worktreePath: path.join(root, 'wrong'), worktreeBranch: 'wrong' } : {}),
        dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), revision: 7, phase: review ? 'acceptance' : 'implement',
          candidateCommit: commit, workspaceBase: commit, taskRunId: turn.id,
          ...(review ? { worker: departed, review: kind === 'review-ready'
            ? { kind: 'ready', phase: 'acceptance', claimKey, candidateCommit: commit }
            : { kind: 'running', phase: 'acceptance', claimKey, candidateCommit: commit, taskRunId: turn.id } } : {}) }) } });
      if (review) await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: 'review_claimed', idempotencyKey: claimKey, payload: {} } });
      if (reclassify) {
        await prisma.taskGraphNode.update({ where: { id: sibling.id }, data: { status: kind === 'reclassify-admission' ? 'attention' : 'verifying' } });
        const child = await prisma.task.create({ data: { name: 'saved sibling' } });
        await prisma.taskGraphExecution.update({ where: { id: siblingJob.id }, data: {
          status: kind === 'reclassify-admission' ? 'attention' : 'integrated', commit, claimToken: 'sibling-claim', childTaskId: child.id,
          worktreePath: root, worktreeBranch: 'refs/heads/main',
          dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), revision: 7, phase: kind === 'reclassify-admission' ? 'implement' : 'acceptance',
            state: kind === 'reclassify-admission' ? 'waiting_decision' : 'active', worker: departed, candidateCommit: commit, workspaceBase: commit,
            lastFailure: { code: 'dispatch_failed', detail: 'previous failure' } }) } });
        if (kind === 'reclassify-review') await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: sibling.id, kind: 'review_claimed', idempotencyKey: claimKey, payload: {} } });
      }
      const args = { runId: run.id, nodeKey: 'A', snapshotHash: run.snapshotHash, executionId: job.id, taskRunId: turn.id,
        commit, actorId: 'lock-admin', reason: 'audited failure', evidencePath: 'fixture://audit', blockerKind: 'environment_failed' as const };
      const recover = () => reclassify ? reclassifyIncompleteDelivery(args) : review ? recoverGraphReview(node.id) : recoverGraphExecution(job.id);
      const holder = () => kind === 'reclassify-admission' ? admitNode(sibling.id, { source: 'operator', id: 'lock-wake' })
        : reserveGraphReviewClaim({ runId: run.id, nodeId: reclassify ? sibling.id : node.id, phase: 'acceptance', claimKey, payload: {} });
      try {
        if (reclassify) {
          await assert.rejects(reclassifyIncompleteDelivery({ ...args, actorId: 'stranger' }), /管理员/);
          await assert.rejects(reclassifyIncompleteDelivery({ ...args, snapshotHash: 'stale' }), /审批版本/);
        }
        const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        if (paused) {
          await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'paused' } });
          if (kind === 'question' || kind === 'answered') {
            assert.equal(await recover(), true);
            const saved = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
            const progress = executionProgress(saved.dispatchMetadata)!;
            assert.equal(progress.revision, 9); assert.equal(progress.platformAttempts, 0);
            assert.equal(progress.state, 'waiting_for_user'); assert.equal(progress.waitingKind, kind);
            assert.equal(progress.candidateCommit, commit); assert.equal(saved.claimToken, 'original-claim');
            assert.equal(saved.taskRunId, turn.id); await recover();
            assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'execution_outcome' } }), 2);
          } else {
            await assert.rejects(recover(), /Task graph is paused/);
            assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), before);
            assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'execution_outcome' } }), 0);
            assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id } })).status, turn.status);
          }
          assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'paused');
          console.log(`PASS paused ${kind}: in-flight question/answer saves; active-only outcomes roll back`);
          continue;
        }
        const participant = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: turn.id } });
        const implicit = ['workspace', 'retry', 'review-running'].includes(kind) ? { taskRunId: turn.id, participantId: participant.id } : {};
        if (['workspace', 'retry', 'review-running'].includes(kind)) assert(implicit.taskRunId && implicit.participantId);
        const evidence = await contend(holder, recover, { ...implicit, holderTransactionContains: kind === 'reclassify-admission' ? 'receiptKey' : undefined, skipTransactions: completed ? 1 : 0, canFinishWithoutWait: kind === 'question' || kind === 'answered' });
        const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        const events = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: { in: ['execution_outcome', 'node_delivery_reclassified', 'implementation_recovery_scheduled'] } }, orderBy: { createdAt: 'asc' } });
        console.log(JSON.stringify({ kind, ...evidence, before, after, events }));
        assert.equal(evidence.results[1].status, 'fulfilled', `${kind}: recovery must commit without deadlock`);
        if (!review && !reclassify) {
          assert.equal(evidence.results[0].status, 'rejected');
          assert.match(evidence.results[0].error || '', /Review reservation no longer owns verification/);
        } else assert.equal(evidence.results[0].status, 'fulfilled');
        const progress = executionProgress(after.dispatchMetadata)!;
        assert.equal(progress.candidateCommit, commit); assert.equal(progress.workspaceBase, commit);
        assert.equal(progress.revision, kind === 'workspace' || review || reclassify ? 8 : 9);
        assert.equal(progress.platformAttempts, kind === 'retry' || review ? 1 : 0);
        assert.equal(progress.taskRunId, turn.id);
        assert.equal(after.claimToken, kind === 'retry' ? null : 'original-claim');
        assert.equal(after.status, kind === 'retry' ? 'ready' : review ? 'integrated' : 'attention');
        assert.equal((await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: turn.id } })).controlMetadata, JSON.stringify({ nativeSessionId: 'native-original' }));
        assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshotHash, run.snapshotHash);
        if (kind === 'retry' || kind === 'workspace' || kind === 'review-running') {
          assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id } })).status, 'interrupted');
          assert.equal((await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: turn.id } })).status, 'interrupted');
        }
        assert.equal(events.filter(event => event.kind === 'execution_outcome' && event.nodeId === node.id).length, kind === 'workspace' || review || reclassify ? 1 : 2);
        if (reclassify) {
          assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: successor.id } })).status, 'planned');
          assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: sibling.id } })).status, kind === 'reclassify-admission' ? 'ready' : 'verifying');
          if (kind === 'reclassify-admission') {
            assert.equal(events.filter(event => event.kind === 'implementation_recovery_scheduled').length, 1);
            const admitted = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: siblingJob.id } });
            assert.equal(admitted.status, 'ready');
            assert.equal(executionProgress(admitted.dispatchMetadata)?.platformAttempts, 0);
            assert.equal(executionProgress(admitted.dispatchMetadata)?.revision, 8);
          }
        }
        const count = events.length;
        await recover();
        assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: { in: ['execution_outcome', 'node_delivery_reclassified', 'implementation_recovery_scheduled'] } } }), count, 'Replay cannot spend budget or duplicate outcome');
        console.log(`PASS ${kind}: SQL contention resolves and ledger/ownership/budget/idempotency match`);
      } catch (error) { failures.push(`${paused ? "paused " : ""}${kind}: ${String(error)}`); console.error(`FAIL ${paused ? "paused " : ""}${kind}: ${String(error)}`); }
      finally { await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.delete({ where: { id: parent.id } }); }
    }
    assert.deepEqual(failures, []);
  } finally {
    if (admin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID; else process.env.FEISHU_ADMIN_OPEN_ID = admin;
    await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
