import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { pendingReviewRepairTx } from '../src/lib/task-graph/pending-review-repair-contract';
import { recoverPendingReviewRepairs } from '../src/lib/task-graph/pending-review-repair';

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.match(url.searchParams.get('schema') || '', /^task_graph_test_/);
  assert.equal(url.searchParams.get('connection_limit'), '1');
  const repo = mkdtempSync(path.join(tmpdir(), 'pending-review-observation-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repo, 'value'), 'candidate'); git('add', '.'); git('commit', '-m', 'candidate'); const commit = git('rev-parse', 'HEAD');
  const parent = await prisma.task.create({ data: { name: 'single connection repair' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'fixture://pending-observation', nodes: [{ key: 'A', goal: 'repair after exit', dependsOn: [], acceptance: { mode: 'automatic', checks: ['behavior'] },
      executions: [{ key: 'repo', repository: repo, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'repair' }] }] } });
  const node = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: run.id }, include: { executions: true } }), job = node.executions[0];
  const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${node.id}`, name: 'review' } });
  const implWriter = await createGraphWriter(), reviewWriter = await createGraphWriter(), phaseWriter = await createGraphWriter();
  const decision = { approved: false, note: 'Observed scoped defect', failureKind: 'in_scope_defect', failureKey: 'acceptance:behavior', executionIds: [job.id] };
  const review = await prisma.taskRun.create({ data: { taskId: reviewTask.id, status: 'completed', summary: `TASK_GRAPH_REVIEW ${JSON.stringify(decision)}`, controlMetadata: JSON.stringify({ graphWriter: reviewWriter }), participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'tester', status: 'completed' } } } });
  const impl = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'completed', controlMetadata: JSON.stringify({ graphWriter: implWriter }), participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', status: 'completed' } } } });
  try {
    const progress = { ...initialExecutionProgress(), phase: 'acceptance' as const, candidateCommit: commit, workspaceBase: commit, worker: phaseWriter,
      review: { kind: 'running' as const, phase: 'acceptance' as const, claimKey: 'review', taskRunId: review.id, candidateCommit: commit } };
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, claimToken: 'original', taskRunId: impl.id, dispatchMetadata: metadataWithProgress(null, progress) } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention', evidence: { summary: 'defect', checks: [{ name: 'behavior', passed: false, evidence: 'observed defect' }] } } });
    assert(await prisma.$transaction(tx => pendingReviewRepairTx(tx, node.id)), 'Ledger selection must not perform external writer observation while holding the only connection');
    for (const release of [async () => {}, () => releaseTaskRunWriter(impl.id, implWriter.nonce), () => releaseTaskRunWriter(review.id, reviewWriter.nonce)]) {
      await release(); await recoverPendingReviewRepairs(run.id);
      assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'integrated', 'Every real writer must exit before repair');
    }
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(null, { ...progress, workerReleasedAt: new Date().toISOString() }) } });
    await recoverPendingReviewRepairs(run.id); await recoverPendingReviewRepairs(run.id);
    const repaired = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(repaired.status, 'ready'); assert.equal(executionProgress(repaired.dispatchMetadata)?.repairAttempts, 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 1);
    console.log('Single connection: pending review ledger does not block writer release; real implementation, reviewer and phase exits required; exactly one repair');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.deleteMany({ where: { id: { in: [parent.id, reviewTask.id] } } });
    await prisma.$disconnect(); rmSync(repo, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
