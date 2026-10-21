import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { executionProgress, initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { graphValidationArchiveForTask } from '../src/lib/task-graph/validation-archive-access';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { prepareAcceptanceRuntime } from '../src/lib/task-graph/acceptance-runtime';
import { cleanupFinishedWorkspaces, cleanupCompletedNodeWorkspaces } from '../src/lib/task-graph/completed-workspaces';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution, recordExecutionDispatch,
  completeExecution, markNodeIntegrationsReady, submitNodeVerification } from '../src/lib/task-graph/store';
import { ensureIntegrationRef, ensureJobWorktree, integrateJobWorktree } from '../src/lib/task-graph/worktree';

async function main() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'graph-completion-'));
  const previousWorkspaceRoot = process.env.AP_WORKSPACE_ROOT;
  process.env.AP_WORKSPACE_ROOT = path.join(root, 'workspaces');
  const previousValidationRoot = process.env.TASK_GRAPH_VALIDATION_ROOT;
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, encoding: 'utf8' }).trim();
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(repo, '.gitignore'), 'scratch/\nnode_modules/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline'); const base = git(repo, 'rev-parse', 'HEAD');
  const parent = await prisma.task.create({ data: { name: 'completion-test' } });
  const child = await prisma.task.create({ data: { id: `task-graph-${randomUUID()}`, name: 'completion-child' } });
  let runId: string | undefined;
  try {
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: root,
      definition: { specRef: 'test://completion', nodes: [{ key: 'S1', goal: 'Save and reopen', dependsOn: [],
        acceptance: { mode: 'automatic', checks: ['roundtrip'] }, executions: [{ key: 'repo', repository: repo,
          gitRef: 'refs/heads/main', baseCommit: base, agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
    runId = run.id;
    await releaseReadyNodes(run.id); await claimNode(run.id, 'S1', 'claim');
    const execution = await claimExecution(run.id, 'S1', 'repo', 'claim'); assert.ok(execution);
    const integration = await ensureIntegrationRef({ repoPath: repo, runId: run.id, baseRef: 'refs/heads/main', baseCommit: base });
    const workspace = await ensureJobWorktree({ repoPath: repo, runId: run.id, jobId: execution.id, baseRef: integration.ref, baseCommit: base });
    await fs.writeFile(path.join(workspace.path, 'feature.txt'), 'feature');
    git(workspace.path, 'add', 'feature.txt'); git(workspace.path, 'commit', '-m', 'feature');
    await recordExecutionDispatch({ runId: run.id, nodeKey: 'S1', executionKey: 'repo', claimToken: 'claim',
      childTaskId: child.id, worktreePath: workspace.path, worktreeBranch: workspace.branch });
    const result = await integrateJobWorktree({ repoPath: repo, runId: run.id, jobId: execution.id,
      integrationRef: integration.ref, expectedIntegrationCommit: base, baseCommit: base, verify: async (directory) => {
        await fs.mkdir(path.join(directory, 'scratch')); await fs.mkdir(path.join(directory, 'node_modules'));
        await fs.writeFile(path.join(directory, 'scratch', 'roundtrip.json'), '{"saved":true}');
        await fs.writeFile(path.join(directory, 'node_modules', 'cache.txt'), 'disposable');
      } });
    await completeExecution({ runId: run.id, nodeKey: 'S1', executionKey: 'repo', claimToken: 'claim', commit: result.commit, evidence: {} });
    const validation = await prepareAcceptanceRuntime(execution.nodeId, 'first-review', []);
    await fs.writeFile(path.join(validation.directory, 'acceptance.json'), '{"reviewed":true}');
    await markNodeIntegrationsReady(run.id, 'S1');
    await cleanupCompletedNodeWorkspaces(run.id, 'S1');
    assert.equal(await fs.readFile(path.join(workspace.path, 'scratch/roundtrip.json'), 'utf8'), '{"saved":true}', 'Keep evidence while awaiting review');
    assert.equal(await fs.readFile(path.join(validation.directory, 'acceptance.json'), 'utf8'), '{"reviewed":true}', 'Unfinished verification retains runtime');
    await submitNodeVerification({ runId: run.id, nodeKey: 'S1', actorId: 'system', evidence: {
      checks: [{ name: 'roundtrip', passed: true, evidence: 'saved and reopened' }], summary: 'pass' } });
    const participant = { gatewayId: 'local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
    await assert.rejects(executeViaLocalHarness({ taskId: child.id, taskName: 'closed job', orchestrationMode: 'single',
      participants: [participant], workingDirectory: workspace.path }, 'run', 'member', participant, {}, [],
      { transcript: '', latestUserMessage: null }), /代码已冻结/);
    await fs.writeFile(path.join(workspace.path, 'untracked.txt'), 'keep');
    await cleanupCompletedNodeWorkspaces(run.id, 'S1');
    assert.equal(await fs.readFile(path.join(workspace.path, 'untracked.txt'), 'utf8'), 'keep', 'Never delete uncommitted edits');
    await fs.unlink(path.join(workspace.path, 'untracked.txt'));
    const active = await prisma.taskRun.create({ data: { taskId: child.id, mode: 'acpx', status: 'running' } });
    await cleanupCompletedNodeWorkspaces(run.id, 'S1');
    assert.equal(await fs.access(workspace.path).then(() => true, () => false), true, 'Keep active sessions');
    assert.equal(await fs.access(validation.directory).then(() => true, () => false), true, 'Active roles retain validation runtime');
    await prisma.taskRun.update({ where: { id: active.id }, data: { status: 'completed' } });
    await cleanupCompletedNodeWorkspaces(run.id, 'S1');
    assert.equal(await fs.access(workspace.path).then(() => true, () => false), true, 'Completed status alone cannot prove an unknown Writer exited');
    // This fixture never launched a harness. Release its supervisor and prove no nonce-bearing child remains.
    const releasedWorker = await createGraphWriter();
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const progress = executionProgress(current.dispatchMetadata) || initialExecutionProgress();
    await prisma.taskGraphExecution.update({ where: { id: execution.id }, data: { dispatchMetadata: metadataWithProgress(current.dispatchMetadata,
      { ...progress, worker: releasedWorker, workerReleasedAt: new Date().toISOString() }) } });
    await Promise.all([cleanupCompletedNodeWorkspaces(run.id, 'S1'), cleanupCompletedNodeWorkspaces(run.id, 'S1')]);
    assert.equal(await fs.access(workspace.path).then(() => true, () => false), false, 'Release the completed checkout');
    assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), base);
    assert.equal(git(repo, 'rev-parse', integration.ref), result.commit, 'Keep submitted Git history');
    assert.equal(git(repo, 'rev-parse', workspace.branch), result.commit, 'Cleanup never deletes the task branch');
    const receipts = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: 'workspace_cleaned' } });
    assert.equal(receipts.length, 1, 'Concurrent cleanup must leave one receipt');
    const payload = receipts[0].payload;
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.resultsDirectory === 'string');
    assert.equal(await fs.readFile(path.join(payload.resultsDirectory, 'files/scratch/roundtrip.json'), 'utf8'), '{"saved":true}');
    assert.equal(await fs.access(path.join(payload.resultsDirectory, 'files/node_modules')).then(() => true, () => false), false);
    const archives = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: 'validation_workspace_cleaned' } });
    assert.equal(archives.length, 1, 'Concurrent cleanup archives validation once');
    const saved = archives[0].payload;
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.directory === 'string');
    assert.equal(await fs.readFile(path.join(saved.directory, 'files', path.basename(validation.directory), 'acceptance.json'), 'utf8'), '{"reviewed":true}');
    assert.equal(await fs.access(validation.directory).then(() => true, () => false), false);
    assert.equal(await graphValidationArchiveForTask(child.id), saved.directory);
    assert.equal(await graphValidationArchiveForTask(`task-graph-discussion-${execution.id}`), saved.directory);
    assert.equal(await graphValidationArchiveForTask('task-graph-unrelated'), null);
    await prisma.taskGraphEvent.delete({ where: { id: archives[0].id } });
    await fs.mkdir(validation.directory, { recursive: true }); await fs.writeFile(path.join(validation.directory, 'acceptance.json'), '{"reviewed":true}');
    await cleanupFinishedWorkspaces();
    assert.equal(await fs.access(validation.directory).then(() => true, () => false), false, 'Legacy worktree-cleaned nodes are still scanned for runtime cleanup');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'validation_workspace_cleaned' } }), 1);
    await cleanupCompletedNodeWorkspaces(run.id, 'S1');
    console.log('Completed jobs archive evidence and release worktrees; active, unreviewed and dirty jobs are retained');
  } finally {
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
    if (previousWorkspaceRoot === undefined) delete process.env.AP_WORKSPACE_ROOT; else process.env.AP_WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousValidationRoot === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = previousValidationRoot;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
