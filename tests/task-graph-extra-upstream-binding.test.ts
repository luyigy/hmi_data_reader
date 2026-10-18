import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { prepareUpstreamInputs, graphInputsForTask } from '../src/lib/task-graph/upstream-inputs';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'extra-upstream-binding-'));
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'sources');
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const createRepo = (name: string) => {
    const directory = path.join(root, name); mkdirSync(directory);
    git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(directory, '.gitignore'), '.venv/\n');
    writeFileSync(path.join(directory, 'contract.json'), '{"version":"original"}');
    git(directory, 'add', '.'); git(directory, 'commit', '-m', 'original');
    return { directory, commit: git(directory, 'rev-parse', 'HEAD') };
  };
  const reader = createRepo('reader'), model = createRepo('model');
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(reader.directory, '.venv')]);
  const delivery = path.join(root, 'reader-delivery');
  git(reader.directory, 'worktree', 'add', '-b', 'reader-delivery', delivery, reader.commit);
  writeFileSync(path.join(delivery, 'contract.json'), '{"version":"R01-delivered"}');
  git(delivery, 'add', '.'); git(delivery, 'commit', '-m', 'R01 delivery');
  const delivered = git(delivery, 'rev-parse', 'HEAD');
  writeFileSync(path.join(reader.directory, 'uncommitted.txt'), 'original local file remains untouched');
  const archive = path.join(root, 'R01-archive'); mkdirSync(archive); writeFileSync(path.join(archive, 'evidence.json'), '{"source":"R01-delivered"}');
  const parent = await prisma.task.create({ data: { name: 'extra repo dependency binding' } });
  const child = await prisma.task.create({ data: { name: 'M01 consumer' } });
  const extraRepositories = [{ repository: reader.directory, access: 'read' as const }];
  const execution = (repository: string, baseCommit: string) => [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit, agentSelector: 'local:codex', instructions: 'fixture' }];
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://extra-upstream', nodes: [
    { key: 'R01', goal: 'Reader contract', dependsOn: [], acceptance: { mode: 'automatic', checks: ['contract'] }, executions: execution(reader.directory, reader.commit) },
    { key: 'M01', goal: 'Read delivered Reader contract', dependsOn: ['R01'], extraRepositories, acceptance: { mode: 'automatic', checks: ['contract'] }, executions: execution(model.directory, model.commit) },
    { key: 'ORDER', goal: 'Only ordering', dependsOn: ['R01'], consumeUpstream: 'none', extraRepositories, acceptance: { mode: 'automatic', checks: ['contract'] }, executions: execution(model.directory, model.commit) },
  ] } });
  try {
    const source = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'R01' } }, include: { executions: true } });
    const target = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'M01' } }, include: { executions: true } });
    const sourceJob = source.executions[0], targetJob = target.executions[0];
    await prisma.taskGraphNode.update({ where: { id: source.id }, data: { status: 'passed' } });
    await prisma.taskGraphExecution.update({ where: { id: sourceJob.id }, data: { status: 'integrated', commit: delivered } });
    await prisma.taskGraphExecution.update({ where: { id: targetJob.id }, data: { childTaskId: child.id, claimToken: 'attempt-one' } });
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: source.id, kind: 'workspace_cleaned', idempotencyKey: 'R01-archive', payload: { executionId: sourceJob.id, commit: delivered, resultsDirectory: archive } } });
    const prepared = await prepareUpstreamInputs(targetJob.id);
    assert.equal(prepared.manifest.inputs.length, 1, 'Extra repo permission must not erase the selected predecessor delivery');
    const input = prepared.manifest.inputs[0];
    assert.equal(input.commit, delivered); assert.deepEqual(input.executions, ['R01/repo']);
    assert.deepEqual(input.resultsDirectories, [archive]); assert.equal(input.projectEnvPath, path.join(reader.directory, '.venv'));
    assert.equal(readFileSync(path.join(input.sourcePath, 'contract.json'), 'utf8'), '{"version":"R01-delivered"}');
    const access = await graphInputsForTask(child.id);
    assert.ok(access.paths.includes(reader.directory), 'Original explicit read grant remains available');
    assert.ok(access.paths.includes(input.sourcePath)); assert.ok(access.paths.includes(archive));
    assert.ok(access.paths.includes(path.join(reader.directory, '.venv'))); assert.deepEqual(access.writablePaths, []);
    assert.equal(JSON.parse(access.env.TASK_GRAPH_EXTRA_REPOS_JSON)[0].commit, reader.commit);
    assert.equal(JSON.parse(access.env.TASK_GRAPH_UPSTREAM_INPUTS_JSON)[0].inputs[0].commit, delivered);
    const result = await runSandboxedGraphCheck(['python3', '-c', 'import os,json,pathlib;m=json.loads(os.environ["TASK_GRAPH_UPSTREAM_INPUTS_JSON"])[0];i=m["inputs"][0];assert json.loads((pathlib.Path(i["sourcePath"])/"contract.json").read_text())["version"]=="R01-delivered";assert json.loads((pathlib.Path(i["resultsDirectories"][0])/"evidence.json").read_text())["source"]=="R01-delivered";print("Model read delivered Reader contract")'], model.directory, access.env, access.paths);
    assert.match(result.stdout, /Model read delivered Reader contract/);
    writeFileSync(path.join(delivery, 'contract.json'), '{"version":"R01-later"}'); git(delivery, 'add', '.'); git(delivery, 'commit', '-m', 'later delivery');
    const later = git(delivery, 'rev-parse', 'HEAD');
    await prisma.taskGraphExecution.update({ where: { id: sourceJob.id }, data: { commit: later } });
    const replay = await prepareUpstreamInputs(targetJob.id);
    assert.equal(replay.manifest.hash, prepared.manifest.hash); assert.equal(replay.manifest.inputs[0].commit, delivered, 'Current attempt remains frozen when predecessor advances');
    assert.equal(readFileSync(path.join(replay.manifest.inputs[0].sourcePath, 'contract.json'), 'utf8'), '{"version":"R01-delivered"}');
    await prisma.taskGraphExecution.update({ where: { id: targetJob.id }, data: { claimToken: 'attempt-two' } });
    assert.equal((await prepareUpstreamInputs(targetJob.id)).manifest.inputs[0].commit, later, 'A new claim resolves the new approved delivery');
    const ordering = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'ORDER' } } });
    assert.deepEqual((await prepareUpstreamInputs(ordering.id)).manifest.inputs, [], 'Only explicit consumeUpstream none disables data consumption');
    assert.equal(git(reader.directory, 'rev-parse', 'HEAD'), reader.commit);
    assert.equal(readFileSync(path.join(reader.directory, 'contract.json'), 'utf8'), '{"version":"original"}');
    assert.equal(readFileSync(path.join(reader.directory, 'uncommitted.txt'), 'utf8'), 'original local file remains untouched');
    console.log('Extra repo read permission preserves delivered source, archive and environment; retries freeze input while original HEAD and local files stay untouched');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
