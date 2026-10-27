import { prepareGraphConversationTask } from '../src/lib/task-graph/conversation-task';
import { createRequire } from 'node:module';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, recoverTaskGraphNode, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode } from '../src/lib/task-graph/store';
import { prepareUpstreamInputs, graphInputsForTask } from '../src/lib/task-graph/upstream-inputs';
import { cleanupUpstreamSources } from '../src/lib/task-graph/upstream-cache-cleanup';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { materializeUpstream } from '../src/lib/task-graph/upstream-source';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-input-contract-'));
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  function repo(name: string) {
    const directory = path.join(root, name); mkdirSync(directory);
    git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'test@example.test');
    writeFileSync(path.join(directory, '.gitignore'), '.venv/\n');
    writeFileSync(path.join(directory, 'capability.py'), 'value = "base"\n');
    git(directory, 'add', '.'); git(directory, 'commit', '-m', 'base'); return directory;
  }
  const producer = repo('producer'), consumer = repo('consumer');
  const baseProducer = git(producer, 'rev-parse', 'HEAD'), baseConsumer = git(consumer, 'rev-parse', 'HEAD');
  for (const [directory, identity] of [[producer, 'producer-env'], [consumer, 'consumer-env']]) {
    execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(directory, '.venv')]);
    const packages = execFileSync(path.join(directory, '.venv/bin/python'), ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(packages, 'project_identity.py'), `value = ${JSON.stringify(identity)}\n`);
  }
  writeFileSync(path.join(producer, 'capability.py'), 'value = "first"\n'); git(producer, 'add', '.'); git(producer, 'commit', '-m', 'P1'); const first = git(producer, 'rev-parse', 'HEAD');
  writeFileSync(path.join(producer, 'unverified.txt'), 'unfinished'); git(producer, 'add', '.'); git(producer, 'commit', '-m', 'unpassed'); const bad = git(producer, 'rev-parse', 'HEAD');
  writeFileSync(path.join(producer, 'capability.py'), 'value = "bad-combined"\n'); git(producer, 'add', '.'); git(producer, 'commit', '-m', 'bad join'); const badJoin = git(producer, 'rev-parse', 'HEAD');
  git(producer, 'switch', '-c', 'clean', first);
  writeFileSync(path.join(producer, 'capability.py'), 'value = "fixed-second"\n'); git(producer, 'add', '.'); git(producer, 'commit', '-m', 'clean P2'); const second = git(producer, 'rev-parse', 'HEAD');
  const parent = await prisma.task.create({ data: { name: 'generic inputs' } });
  const child = await prisma.task.create({ data: { name: 'consumer' } });
  const execution = (repository: string, commit: string) => [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture' }];
  const common = { acceptance: { mode: 'automatic' as const, checks: ['contract'] } };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://inputs', nodes: [
    { ...common, key: 'P1', goal: 'first', dependsOn: [], executions: execution(producer, baseProducer) },
    { ...common, key: 'P2', goal: 'second', dependsOn: ['P1'], executions: execution(producer, baseProducer) },
    { ...common, key: 'U', goal: 'unverified', dependsOn: [], executions: execution(producer, baseProducer) },
    { ...common, key: 'C', goal: 'consume', dependsOn: ['P2'], executions: execution(consumer, baseConsumer) },
    { ...common, key: 'NONE', goal: 'ordering only', dependsOn: ['P2'], consumeUpstream: 'none', executions: execution(consumer, baseConsumer) },
    { ...common, key: 'EXPLICIT', goal: 'explicit transitive', dependsOn: ['P2'], consumeUpstream: ['P1/repo'], executions: execution(consumer, baseConsumer) },
  ] } });
  const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } });
  const node = (key: string) => { const result = nodes.find(item => item.key === key); assert.ok(result); return result; };
  const job = (key: string) => node(key).executions[0];
  try {
    for (const [key, commit] of [['P1', first], ['P2', second], ['U', bad]]) {
      await prisma.taskGraphNode.update({ where: { id: node(key).id }, data: { status: key === 'U' ? 'attention' : 'passed' } });
      await prisma.taskGraphExecution.update({ where: { id: job(key).id }, data: { status: 'integrated', commit } });
    }
    await prisma.taskGraphExecution.update({ where: { id: job('C').id }, data: { childTaskId: child.id, claimToken: 'attempt-one' } });
    const report = path.join(root, 'archived-contract'); mkdirSync(report); writeFileSync(path.join(report, 'contract.json'), '{"ok":true}');
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node('P2').id, idempotencyKey: 'fixture-archive', kind: 'workspace_cleaned', payload: { executionId: job('P2').id, commit: second, resultsDirectory: report } } });
    writeFileSync(path.join(producer, 'capability.py'), 'value = "UNAPPROVED WORKING COPY"\n');
    const prepared = await prepareUpstreamInputs(job('C').id);
    assert.equal(prepared.manifest.inputs.length, 1);
    const input = prepared.manifest.inputs[0];
    assert.equal(input.commit, second); assert.deepEqual(input.executions.sort(), ['P1/repo', 'P2/repo']);
    assert.deepEqual(input.resultsDirectories, [report]);
    assert.equal(readFileSync(path.join(input.sourcePath, 'capability.py'), 'utf8'), 'value = "fixed-second"\n');
    assert.equal(existsSync(path.join(input.sourcePath, '.git')), false);
    assert.equal(git(producer, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
    const script = 'import os,sys,json,subprocess,project_identity as p; assert p.value=="consumer-env"; m=json.loads(os.environ["TASK_GRAPH_UPSTREAM_INPUTS_JSON"])[0]; u=m["inputs"][0]; r=subprocess.check_output([u["pythonExecutable"],"-c",\'import project_identity,capability; print(project_identity.value, capability.value)\'],cwd=u["sourcePath"],text=True); assert r.strip()=="producer-env fixed-second"; print(r)';
    const check = await runSandboxedGraphCheck(['python3', '-c', script], consumer, prepared.env, prepared.readOnlyPaths);
    assert.match(check.stdout, /producer-env fixed-second/);
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo bad > "$1"', 'sh', path.join(input.sourcePath, 'capability.py')], consumer, prepared.env, prepared.readOnlyPaths), /Read-only/);
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo bad > "$1"', 'sh', path.join(input.projectEnvPath!, 'bad')], consumer, prepared.env, prepared.readOnlyPaths), /Read-only/);
    renameSync(path.join(consumer, '.venv'), path.join(consumer, '.held-venv'));
    try {
      const system = await runSandboxedGraphCheck(['python3', '-c', 'import sys,os;assert sys.prefix != '+JSON.stringify(input.projectEnvPath)+';assert not os.getenv("VIRTUAL_ENV");print("main-has-no-environment")'], consumer, prepared.env, [...prepared.readOnlyPaths, producer]);
      assert.match(system.stdout, /main-has-no-environment/, 'A main repository without an environment never borrows an upstream environment');
    } finally { renameSync(path.join(consumer, '.held-venv'), path.join(consumer, '.venv')); }
    assert.equal((await graphInputsForTask(child.id)).instructions.includes(prepared.manifest.hash), true);
    assert.equal((await graphInputsForTask('task-graph-discussion-' + job('C').id)).instructions.includes(prepared.manifest.hash), true);
    assert.equal((await graphInputsForTask('task-graph-review-' + node('C').id)).instructions.includes(prepared.manifest.hash), true);
    await prisma.taskGraphExecution.update({ where: { id: job('P2').id }, data: { commit: badJoin } });
    assert.equal((await prepareUpstreamInputs(job('C').id)).manifest.inputs[0].commit, second, 'Old attempt remains pinned');
    await prisma.taskGraphExecution.update({ where: { id: job('C').id }, data: { claimToken: 'attempt-two' } });
    await assert.rejects(prepareUpstreamInputs(job('C').id), /夹带未通过/);
    await prisma.taskGraphExecution.update({ where: { id: job('P2').id }, data: { commit: second } });
    assert.equal((await prepareUpstreamInputs(job('NONE').id)).manifest.inputs.length, 0);
    const explicit = await prepareUpstreamInputs(job('EXPLICIT').id); assert.equal(explicit.manifest.inputs[0].commit, second);
    await prisma.taskGraphNode.update({ where: { id: node('P1').id }, data: { status: 'attention' } });
    await prisma.taskGraphExecution.update({ where: { id: job('NONE').id }, data: { claimToken: 'new-ordering-attempt' } });
    await assert.rejects(prepareUpstreamInputs(job('NONE').id), /未达到批准完成条件/);
    await prisma.taskGraphNode.update({ where: { id: node('P1').id }, data: { status: 'passed' } });
    writeFileSync(path.join(producer, 'capability.py'), 'value = "fixed-third"\n'); git(producer, 'add', 'capability.py'); git(producer, 'commit', '-m', 'approved upstream repair');
    const third = git(producer, 'rev-parse', 'HEAD');
    await prisma.taskGraphExecution.update({ where: { id: job('P2').id }, data: { commit: third } });
    const changed = await prepareUpstreamInputs(job('C').id);
    assert.equal(changed.manifest.inputs[0].commit, third);
    assert.notEqual(changed.manifest.hash, prepared.manifest.hash);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node('C').id, kind: 'task_inputs_changed' } }), 1);
    assert.equal((await prepareUpstreamInputs(job('EXPLICIT').id)).manifest.hash, explicit.manifest.hash);
    const metadata = input.sourcePath + '.json'; const old = new Date(Date.now() - 8 * 86400_000); utimesSync(metadata, old, old);
    await cleanupUpstreamSources(); assert.equal(existsSync(input.sourcePath), true, 'Active graph protects old cache');
    await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'completed' } });
    await cleanupUpstreamSources(); assert.equal(existsSync(input.sourcePath), false);
    const recreated = await prepareUpstreamInputs(job('EXPLICIT').id); assert.equal(recreated.manifest.hash, explicit.manifest.hash);
    assert.equal(git(producer, 'cat-file', '-t', second), 'commit', 'Cleanup preserves delivery Git history and project environment');
    const cachedFile = path.join(recreated.manifest.inputs[0].sourcePath, 'capability.py');
    chmodSync(cachedFile, 0o644); writeFileSync(cachedFile, 'corrupted');
    await assert.rejects(prepareUpstreamInputs(job('EXPLICIT').id), /内容与 Git 不一致/);
    rmSync(recreated.manifest.inputs[0].sourcePath, { recursive: true });
    assert.equal((await prepareUpstreamInputs(job('EXPLICIT').id)).manifest.hash, explicit.manifest.hash);
    assert.equal(existsSync(path.join(producer, '.venv/bin/python')), true);
    await prisma.taskGraphExecution.update({ where: { id: job('C').id }, data: { commit: baseConsumer, status: 'integrated' } });
    writeFileSync(path.join(consumer, 'capability.py'), 'unapproved consumer edit');
    const task = await prisma.task.findUniqueOrThrow({ where: { id: child.id }, include: { currentTaskSession: true } });
    assert.deepEqual(await prepareGraphConversationTask(task), task, 'Graph conversations retain the original task and session without an extra QA task');
    writeFileSync(path.join(consumer, 'capability.py'), 'value = "base"\n');
    writeFileSync(path.join(producer, 'capability.py'), 'value = "fixed-second"\n');
    writeFileSync(path.join(producer, 'lfs.dat'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 1\n'); git(producer, 'add', 'lfs.dat'); git(producer, 'commit', '-m', 'LFS pointer');
    await assert.rejects(materializeUpstream(producer, git(producer, 'rev-parse', 'HEAD')), /LFS/);
    const gate = await createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: parent.id + ':gate', definition: { specRef: 'gate', nodes: ['X', 'Y', 'Z'].map(key => ({ ...common, key, goal: key, dependsOn: [], executions: execution(key === 'Z' ? consumer : producer, key === 'Z' ? baseConsumer : baseProducer) })) } });
    await releaseReadyNodes(gate.id);
    const claims = await Promise.all([claimNode(gate.id, 'X', 'x'), claimNode(gate.id, 'Y', 'y')]);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: gate.id, kind: 'repository_gate_waiting' } }), 0);
    assert.equal(claims.filter(Boolean).length, 2, 'Independent same-repository worktrees can both be claimed');
    assert.ok(await claimNode(gate.id, 'Z', 'z'), 'Another repository remains parallel');
    await prisma.taskGraphRun.update({ where: { id: gate.id }, data: { status: 'completed' } });
    const require = createRequire(__filename); const feishu = require('../src/lib/task-graph/feishu');
    feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {}; feishu.ensureGraphChildTopic = async () => null;
    const adapter = getHarnessAdapter('codex'); assert.ok(adapter); let starts = 0;
    adapter.execute = async () => { starts++; throw new Error('Input preflight must precede the Harness'); };
    const failure = await createTaskGraphRun({ parentTaskId: parent.id, version: 3, requestKey: parent.id + ':preflight', definition: { specRef: 'preflight', nodes: [
      { ...common, key: 'J', goal: 'source', dependsOn: [], executions: execution(producer, baseProducer) },
      { ...common, key: 'K', goal: 'consumer', dependsOn: ['J'], executions: execution(consumer, baseConsumer).map(job => ({ ...job, launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [] } })) },
    ] } });
    const sourceNode = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: failure.id, key: 'J' } } });
    await prisma.taskGraphNode.update({ where: { id: sourceNode.id }, data: { status: 'passed' } });
    await prisma.taskGraphExecution.updateMany({ where: { nodeId: sourceNode.id }, data: { status: 'integrated', commit: 'f'.repeat(40) } });
    const target = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: failure.id, key: 'K' } } });
    const waitForBlock = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        await runTaskGraphCycle();
        if (await prisma.taskGraphEvent.count({ where: { nodeId: target.id, kind: 'implementation_blocked' } }) === count) {
          const signal = new AbortController(); signal.abort(); await startTaskGraphCoordinator(signal.signal); return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Preflight did not pause: '+JSON.stringify(await prisma.taskGraphEvent.findMany({where:{runId:failure.id},orderBy:{createdAt:'desc'},take:5}))); 
    }
    await waitForBlock(1);
    const paused = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: target.id, kind: 'implementation_blocked' } });
    assert.ok(JSON.stringify(paused.payload).includes('input_preparation'));
    await assert.rejects(recoverTaskGraphNode(failure.id, 'K', 'implementation', 'fixture-input-retry'),
      /Admission deferred.*前置提交没有已完成的汇合版本/, 'Unchanged invalid input is deferred before another execution is dispatched');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: target.id, kind: 'implementation_blocked' } }), 1, 'Admission must not start a second failing attempt');
    assert.equal(starts, 0, 'Bad input never starts a model, including a continuation');
    assert.equal(await prisma.taskRun.count({ where: { taskId: { startsWith: 'task-graph-' }, task: { name: 'K · repo' } } }), 0);
    console.log('Fixed upstream source, archived contracts, frozen attempts, readonly dual environments, ordering-only gate, cache retention/rebuild and atomic repository gate verified');
  } finally {
    const children = await prisma.taskGraphExecution.findMany({ where: { node: { run: { parentTaskId: parent.id } } }, select: { childTaskId: true } });
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.deleteMany({ where: { id: { in: children.flatMap(job => job.childTaskId ? [job.childTaskId] : []) } } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
