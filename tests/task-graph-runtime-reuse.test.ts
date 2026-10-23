import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { prepareDeclaredRuntime } from '../src/lib/task-graph/runtime-preflight';
import { runtimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  let parentId: string | undefined;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-reuse-'));
  const repo = path.join(root, 'repo'), other = path.join(root, 'other'), output = path.join(root, 'output'), bundle = path.join(root, 'skill');
  try {
    for (const dir of [repo, other, output, bundle, path.join(repo, '.agent-platform')]) await fs.mkdir(dir, { recursive: true });
    for (const dir of [repo, other]) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
      execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(dir, '.venv')]);
    }
    await fs.writeFile(path.join(repo, '.gitignore'), '.venv/\n');
    await fs.writeFile(path.join(bundle, 'SKILL.md'), 'fixture');
    await fs.writeFile(path.join(bundle, 'check.mjs'), 'console.log("resource probe passed "+crypto.randomUUID())');
    const declaration = { version: 1, skills: [{ id: 'fixture', package: { path: bundle, sha256: await runtimeResourceDigest(bundle) }, requiredFiles: ['SKILL.md'], checkScript: 'check.mjs' }] };
    await fs.writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(declaration));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
    const sourceDeclaration = await runtimeDeclaration(repo); assert(sourceDeclaration);
    // Same non-Git acceptance directory and two approved Python projects as M6.
    const prepared = await prepareDeclaredRuntime({ workspace: output, resourceWorkspace: repo, sourceDeclaration,
      approvedReadOnlyRoots: [repo, other, bundle], outputDirectory: output });
    assert.match(prepared.receipt?.skills?.[0].output || '', /resource probe passed/);
    const platform = path.join(root, 'platform'); await fs.mkdir(path.join(platform, 'config'), { recursive: true });
    const modulePath = await fs.realpath(path.dirname(require.resolve('playwright/package.json')));
    const corePath = await fs.realpath(path.dirname(require.resolve('playwright-core/package.json')));
    const chrome = await fs.realpath(process.env.AP_RUNTIME_TEST_CHROMIUM_EXECUTABLE || '/opt/google/chrome/chrome');
    const browserBin = path.join(root, 'browser-bin'); await fs.mkdir(browserBin);
    const wrapper = path.join(browserBin, 'browser-probe');
    await fs.writeFile(wrapper, '#!/bin/sh\nprintf "launch\\n" >> "$AP_GRAPH_OUTPUT_DIR/browser-launches"\nexec "' + chrome + '" "$@"\n', { mode: 0o755 });
    const graphDeclaration = { ...declaration, browser: { module: { path: modulePath, sha256: await runtimeResourceDigest(modulePath) }, executable: { path: wrapper, sha256: await runtimeResourceDigest(wrapper) } } };
    await fs.writeFile(path.join(platform, 'config/runtime-resources.json'), JSON.stringify({ [repo]: graphDeclaration }));
    await fs.writeFile(path.join(platform, 'config/runtime-environments.json'), JSON.stringify({ [repo]: [bundle, path.join(repo, '.venv'), modulePath, corePath, browserBin, path.dirname(chrome)] }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: platform, stdio: 'pipe' });
    await fs.writeFile(path.join(platform, 'fixture'), 'platform');
    execFileSync('git', ['add', '.'], { cwd: platform });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture'], { cwd: platform, stdio: 'pipe' });
    // Host-registered shared resources can survive ordinary code commits without repeating probes.
    await fs.unlink(path.join(repo, '.agent-platform/runtime.json')); git('add', '-u');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'use registered resources');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const parent = await prisma.task.create({ data: { name: 'Resource reuse isolation' } }); parentId = parent.id;
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://resource-reuse', nodes: ['T1', 'T2'].map(key => ({
      key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['fixture'] }, executions: [{ key: 'job', repository: repo, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: key }] })) } });
    await releaseReadyNodes(run.id);
    const jobs = [];
    for (const key of ['T1', 'T2']) {
      await claimNode(run.id, key, `claim-${key}`);
      const job = await claimExecution(run.id, key, 'job', `claim-${key}`); assert(job);
      const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: key } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id, worktreePath: repo } });
      await applyExecutionOutcome({ executionId: job.id, claimToken: `claim-${key}`, expectedRevision: 0, outcomeId: 'candidate', outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: commit, candidateCommit: commit } });
      jobs.push(job);
    }
    const prepare = async (taskId: string, workspace = repo, extra: string[] = []) => {
      const outputDirectory = await fs.mkdtemp(path.join(root, 'turn-'));
      return prepareTaskDeclaredRuntime({ platformRepository: platform, taskId, workspace, outputDirectory, approvedReadOnlyRoots: extra });
    };
    const [first, second] = await Promise.all(jobs.map(job => prepare(`task-graph-${job.id}`)));
    assert.equal(second.receipt?.skills?.[0].output, first.receipt?.skills?.[0].output, 'Same Graph/repository resources run the skill probe once even for concurrent tickets');
    const firstJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: jobs[0].id } });
    const progress = executionProgress(firstJob.dispatchMetadata); assert(progress);
    await prisma.taskGraphExecution.update({ where: { id: firstJob.id }, data: { status: 'integrated', commit, dispatchMetadata: metadataWithProgress(firstJob.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    const review = await prepare(`task-graph-review-${firstJob.nodeId}`, output, [repo, other]);
    assert.equal(review.receipt?.skills?.[0].output, first.receipt?.skills?.[0].output, 'Acceptance reuses successful probes rather than reconstructing the environment');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'runtime_probes_verified' } }), 1);
    let launches = 0;
    for (const dir of await fs.readdir(root)) if (dir.startsWith('turn-')) launches += await fs.readFile(path.join(root, dir, 'browser-launches'), 'utf8').then(text => text.trim().split('\n').length, () => 0);
    assert.equal(launches, 1, 'Real Chromium smoke launches once across tickets and acceptance');
    await fs.writeFile(path.join(bundle, 'SKILL.md'), 'changed resource');
    await assert.rejects(prepare(`task-graph-review-${firstJob.nodeId}`, output, [repo, other]), /SHA256/, 'Reuse cannot hide changed resource bytes');
    console.log('Graph resource probes run once across concurrent tickets and acceptance; current byte validation still rejects mutation');
    console.log('Non-Git acceptance prepares the declared skill with two Python repositories without guessing a global environment');
  } finally {
    if (parentId) {
      const runs = await prisma.taskGraphRun.findMany({ where: { parentTaskId: parentId }, include: { nodes: { include: { executions: true } } } });
      const ids = runs.flatMap(run => run.nodes.flatMap(node => node.executions.flatMap(job => job.childTaskId ? [job.childTaskId] : [])));
      await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parentId } });
      await prisma.task.deleteMany({ where: { id: { in: ids } } });
      await prisma.task.delete({ where: { id: parentId } });
    }
    await prisma.$disconnect();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
