import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { adoptLegacyExecutionProgress } from '../src/lib/task-graph/execution-progress-adoption';
import { ensureIntegrationRef, ensureJobWorktree, commitJobWorktree } from '../src/lib/task-graph/worktree';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'progress-adoption-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'source'), 'original'); git('add', '.'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  const parent = await prisma.task.create({ data: { name: 'legacy progress adoption' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://adoption', nodes: [{ key: 'A', goal: 'A', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main',
        baseCommit: baseline, agentSelector: 'local:codex', instructions: 'fixture' }] }],
  } });
  try {
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    const integration = await ensureIntegrationRef({ repoPath: repository, runId: run.id, baseRef: 'refs/heads/main', baseCommit: baseline });
    const workspace = await ensureJobWorktree({ repoPath: repository, runId: run.id, jobId: job.id, baseRef: integration.ref, baseCommit: baseline });
    writeFileSync(path.join(workspace.path, 'first.txt'), 'checkpoint');
    const old = await commitJobWorktree({ repoPath: repository, runId: run.id, jobId: job.id, message: 'old checkpoint' });
    writeFileSync(path.join(workspace.path, 'newer.txt'), 'new committed work');
    const newer = await commitJobWorktree({ repoPath: repository, runId: run.id, jobId: job.id, message: 'newer candidate' });
    writeFileSync(path.join(workspace.path, 'supplement.txt'), 'pause supplement');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention', worktreePath: workspace.path,
      worktreeBranch: workspace.branch, dispatchMetadata: { integrationRef: integration.ref, workspaceBase: baseline } } });
    await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
    const args = { executionId: job.id, workspaceBase: baseline, previousCandidateCommit: old, authorization: 'explicit repair approval' };
    await assert.rejects(adoptLegacyExecutionProgress({ ...args, assertWriterExited: async () => { throw Error('writer still alive'); } }), /writer still alive/);
    assert.equal(git('-C', workspace.path, 'rev-parse', 'HEAD'), newer);
    let proofs = 0;
    const progress = await adoptLegacyExecutionProgress({ ...args, assertWriterExited: async () => { proofs++; } });
    assert.notEqual(progress.candidateCommit, old); assert.notEqual(progress.candidateCommit, newer);
    assert.equal(readFileSync(path.join(workspace.path, 'supplement.txt'), 'utf8'), 'pause supplement');
    assert.equal(readFileSync(path.join(workspace.path, 'newer.txt'), 'utf8'), 'new committed work');
    assert.equal(git('-C', workspace.path, 'status', '--porcelain'), '');
    assert.equal(git('rev-parse', 'HEAD'), baseline, 'Original checkout remains unchanged');
    assert.deepEqual(await adoptLegacyExecutionProgress({ ...args, assertWriterExited: async () => { throw Error('must not execute twice'); } }), progress);
    assert.equal(proofs, 1); assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'execution_progress_adopted' } }), 1);
    await scheduleImplementationRecovery(run.id, 'A', 'authorized-repair');
    const ready = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(ready.status, 'ready');
    assert.equal(git('-C', workspace.path, 'rev-parse', 'HEAD'), progress.candidateCommit);
    console.log('Real Git legacy adoption: old checkpoint + newer commit + dirty supplement preserved, active writer rejected, audit idempotent, original checkout untouched');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
