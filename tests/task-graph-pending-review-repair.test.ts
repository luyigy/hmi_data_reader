import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { scheduleGraphRepair } from '../src/lib/task-graph/repair';
import { pendingReviewRepairTx } from '../src/lib/task-graph/pending-review-repair-contract';
import { recoverPendingReviewRepairs } from '../src/lib/task-graph/pending-review-repair';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'pending-review-fixture-'));
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const repository = (key: string, name: string) => {
    const directory = path.join(root, key + '-' + name); mkdirSync(directory);
    git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(directory, 'identity'), key + '/' + name); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'candidate');
    return { repository: directory, baseCommit: git(directory, 'rev-parse', 'HEAD') };
  };
  const parent = await prisma.task.create({ data: { name: 'Completed review repair handoff' } });
  const keys = ['AUTO', 'HUMAN', 'INVALID', 'CANDIDATE', 'REVIEW_ALIVE', 'UNKNOWN', 'PHASE_ALIVE', 'EXHAUSTED', 'STALE', 'EVIDENCE'];
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://pending-review-repair', nodes: keys.map(key => ({ key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['ticket-behavior'] },
      executions: ['target', 'sibling'].map(name => ({ key: name, ...repository(key, name), gitRef: 'refs/heads/main', agentSelector: 'local:codex', instructions: name })) })) } });
  const writer = await createGraphWriter();
  const fixtures: { key: string; nodeId: string; targetId: string; siblingId: string; implRunId: string }[] = [];
  try {
    for (const key of keys) {
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key } }, include: { executions: true } });
      const target = node.executions.find(job => job.key === 'target'), sibling = node.executions.find(job => job.key === 'sibling'); assert(target && sibling);
      const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${node.id}`, name: 'independent reviewer' } });
      const implementationTask = await prisma.task.create({ data: { name: 'implementation owner' } });
      const decision = { approved: false, note: 'Real scoped failure with explicit execution attribution', failureKind: 'in_scope_defect', failureKey: 'acceptance:ticket-behavior', executionIds: [target.id] };
      const result = key === 'HUMAN' ? { approved: false, note: 'Business choice', failureKind: 'blocked_require_human' } : key === 'INVALID' ? { ...decision, failureKey: 'acceptance:unknown' } : decision;
      const reviewRun = await prisma.taskRun.create({ data: { taskId: reviewTask.id, status: 'completed', mode: 'acpx', summary: `TASK_GRAPH_REVIEW ${JSON.stringify(result)}`,
        controlMetadata: JSON.stringify({ graphWriter: writer }), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'tester', status: 'completed' } } } });
      const implRun = await prisma.taskRun.create({ data: { taskId: implementationTask.id, status: 'completed', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: writer }),
        participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', status: 'completed' } } } });
      if (key !== 'AUTO') await releaseTaskRunWriter(implRun.id, writer.nonce);
      if (key !== 'REVIEW_ALIVE') await releaseTaskRunWriter(reviewRun.id, writer.nonce);
      if (key === 'UNKNOWN') await prisma.taskRun.update({ where: { id: reviewRun.id }, data: { controlMetadata: '{}' } });
      for (const job of node.executions) {
        const commit = job.baseCommit;
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, claimToken: `original-${job.id}`, taskRunId: implRun.id,
          dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), revision: 8, phase: 'acceptance', state: key === 'EXHAUSTED' ? 'exhausted' : 'active', candidateCommit: commit,
            workspaceBase: job.baseCommit, repairAttempts: key === 'AUTO' && job.key === 'sibling' ? 2 : 0, worker: writer, ...(key === 'PHASE_ALIVE' ? {} : { workerReleasedAt: new Date().toISOString() }),
            review: { kind: 'running', phase: 'acceptance', claimKey: `review-${node.id}`, taskRunId: reviewRun.id, candidateCommit: key === 'CANDIDATE' ? 'd'.repeat(40) : commit } }), evidence: { preserved: job.id } } });
      }
      const evidence = { summary: 'Independent reviewer found scoped defect', checks: [{ name: 'ticket-behavior', passed: false, evidence: 'Observed required behavior mismatch' }] };
      await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention', evidence: key === 'EVIDENCE' ? Prisma.DbNull : evidence } });
      if (key === 'AUTO') {
        await assert.rejects(scheduleGraphRepair(run.id, key, decision, evidence), /actual writer exit proof/, 'Original lost-handoff failure is reproduced');
        assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 0, 'Failed handoff rolled back retry budget and event');
      }
      fixtures.push({ key, nodeId: node.id, targetId: target.id, siblingId: sibling.id, implRunId: implRun.id });
    }
    const stale = fixtures.find(item => item.key === 'STALE'); assert(stale);
    const saved = await prisma.$transaction(tx => pendingReviewRepairTx(tx, stale.nodeId)); assert(saved);
    const staleJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: stale.targetId } });
    const oldProgress = executionProgress(staleJob.dispatchMetadata); assert(oldProgress);
    await prisma.taskGraphExecution.update({ where: { id: stale.targetId }, data: { dispatchMetadata: metadataWithProgress(staleJob.dispatchMetadata, { ...oldProgress, revision: oldProgress.revision + 1 }) } });
    await assert.rejects(scheduleGraphRepair(run.id, 'STALE', saved.decision, saved.evidence, saved.binding), /binding, result or evidence changed/, 'Stale caller cannot bypass same-lock revision fencing');
    await prisma.taskGraphExecution.update({ where: { id: stale.targetId }, data: { dispatchMetadata: metadataWithProgress(staleJob.dispatchMetadata, { ...oldProgress, state: 'waiting_decision' }) } });
    await recoverPendingReviewRepairs(run.id);
    const auto = fixtures.find(item => item.key === 'AUTO'); assert(auto);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: auto.targetId } })).status, 'integrated', 'Live old implementation writer defers pickup');
    await releaseTaskRunWriter(auto.implRunId, writer.nonce);
    const siblingBefore = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: auto.siblingId } });
    await recoverPendingReviewRepairs(run.id);
    await recoverPendingReviewRepairs(run.id);
    const target = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: auto.targetId } });
    assert.equal(target.status, 'ready'); assert.equal(executionProgress(target.dispatchMetadata)?.repairAttempts, 1);
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: auto.siblingId } }), siblingBefore, 'Untargeted sibling is unchanged');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'node_repair_scheduled' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'implementation_recovery_scheduled' } }), 0, 'No operator resume request was used');
    for (const item of fixtures.filter(item => item.key !== 'AUTO')) assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: item.nodeId } })).status, 'attention', `${item.key} remains protected`);
    console.log('Current completed scoped review automatically retries a rolled-back repair handoff after actual writer exit, exactly once, with no operator resume and successful siblings unchanged');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { OR: [{ id: parent.id }, { name: { in: ['independent reviewer', 'implementation owner'] } }] } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
