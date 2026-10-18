import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution, recordExecutionDispatch } from '../src/lib/task-graph/store';
import { ensureIntegrationRef, ensureJobWorktree, commitJobWorktree } from '../src/lib/task-graph/worktree';
import { applyExecutionOutcome, bindExecutionTaskRun, executionProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { recoverGraphExecution } from '../src/lib/task-graph/restart-recovery';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-ancestry-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test');
    await fs.writeFile(path.join(repo, 'base'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); const base = git(repo, 'rev-parse', 'HEAD');
    const parent = await prisma.task.create({ data: { name: 'ancestry protection' } });
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://ancestry', nodes: [{
      key: 'N', goal: 'preserve', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: repo, gitRef: 'refs/heads/main', baseCommit: base, agentSelector: 'local:codex', instructions: 'fixture' }],
    }] } });
    await releaseReadyNodes(run.id); const token = 'original-owner'; await claimNode(run.id, 'N', token); const job = await claimExecution(run.id, 'N', 'repo', token); assert(job);
    const integration = await ensureIntegrationRef({ repoPath: repo, runId: run.id, baseRef: job.gitRef, baseCommit: base });
    const workspace = await ensureJobWorktree({ repoPath: repo, runId: run.id, jobId: job.id, baseRef: integration.ref, baseCommit: base });
    await fs.writeFile(path.join(workspace.path, 'candidate'), 'approved candidate');
    const candidate = await commitJobWorktree({ repoPath: repo, runId: run.id, jobId: job.id, message: 'candidate' });
    const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'candidate' } });
    await recordExecutionDispatch({ runId: run.id, nodeKey: 'N', executionKey: 'repo', claimToken: token, childTaskId: task.id, worktreePath: workspace.path, worktreeBranch: workspace.branch });
    const progress = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: 0, outcomeId: 'candidate', outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: base, candidateCommit: candidate } });
    const writer = await createGraphWriter(); const departed = { ...writer, supervisor: { ...writer.supervisor, pid: 2147483647 } };
    await prisma.$transaction(async tx => {
      const taskRun = await tx.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'completed', controlMetadata: JSON.stringify({ graphWriter: departed }), participants: { create: { runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', gatewayNameSnapshot: 'local', role: 'implementer', status: 'completed' } } } });
      await bindExecutionTaskRun(tx, { executionId: job.id, claimToken: token, revision: progress.revision }, taskRun.id);
    });
    git(repo, 'update-ref', workspace.branch, base, candidate);
    await fs.writeFile(path.join(workspace.path, 'supplement'), 'do not commit before proof');
    const status = git(workspace.path, 'status', '--porcelain', '--untracked-files=all');
    assert.equal(await recoverGraphExecution(job.id), false);
    assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), base, 'An ancestry mismatch must not manufacture another checkpoint commit');
    assert.equal(git(workspace.path, 'status', '--porcelain', '--untracked-files=all'), status);
    assert.equal(await fs.readFile(path.join(workspace.path, 'supplement'), 'utf8'), 'do not commit before proof');
    assert.equal(await fs.readFile(path.join(workspace.path, 'candidate'), 'utf8'), 'approved candidate');
    const preserved = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(executionProgress(preserved.dispatchMetadata)?.state, 'ownership_attention');
    assert.equal(executionProgress(preserved.dispatchMetadata)?.candidateCommit, candidate);
    assert.equal(git(repo, 'rev-parse', integration.ref), base);
    console.log('Restart ancestry mismatch preserves original candidate, branch tip and dirty supplements without committing; explicit ownership reconciliation is required');
  } finally { await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
