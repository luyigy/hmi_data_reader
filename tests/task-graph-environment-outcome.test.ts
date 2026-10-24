import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { parseImplementationResult } from '../src/lib/task-graph/implementation-result';
import { getHarnessAdapter } from '../src/lib/harness';
import { RuntimePreparationError } from '../src/lib/task-graph/runtime-preflight';
import { runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { executionRetryLimits } from '../src/lib/task-graph/retry-limits';
import { admitNode } from '../src/lib/task-graph/preparation-recovery';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  assert.throws(() => parseImplementationResult('TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing","blockerKind":"environment_failed","blockerCause":"guess"}'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-environment-outcome-'));
  const platform = path.join(root, 'platform'); await fs.mkdir(path.join(platform, 'config'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const init = async (cwd: string) => {
    await fs.mkdir(cwd, { recursive: true }); git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'fixture@example.test');
    await fs.writeFile(path.join(cwd, 'base'), 'base'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'base');
  };
  await init(platform);
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename), notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  // Redirect only host configuration lookup. Resource pinning, preflight, coordination and the ledger remain real.
  const platformModule: typeof import('../src/lib/platform-repository') = require('../src/lib/platform-repository');
  const originalPlatform = platformModule.platformRepository; platformModule.platformRepository = () => platform;
  const keys = ['MISSING', 'FALSE_REPORT', 'TRANSIENT', 'EXHAUST', 'PREFLIGHT_MISSING', 'PREFLIGHT_TRANSIENT', 'CHECK_MISSING', 'CHECK_TRANSIENT', 'PERMISSION', 'ENGINEERING'];
  const repositories = new Map<string, string>(), resources = new Map<string, string>();
  const grants: Record<string, string[]> = {}, registrations: Record<string, unknown> = {};
  for (const key of keys) {
    const repo = path.join(root, key), resource = path.join(root, key + '-resource');
    await init(repo); await fs.mkdir(resource); await fs.mkdir(path.join(resource, 'weights'));
    await fs.writeFile(path.join(resource, 'weights/model.bin'), 'fixed bytes');
    repositories.set(key, repo); resources.set(key, resource); grants[repo] = [resource];
    registrations[repo] = { version: 1, ocr: { weights: { kind: 'path', path: path.join(resource, 'weights'), sha256: await runtimeResourceDigest(path.join(resource, 'weights')) }, requiredFiles: ['model.bin'] } };
  }
  await fs.writeFile(path.join(platform, 'config/runtime-environments.json'), JSON.stringify(grants));
  await fs.writeFile(path.join(platform, 'config/runtime-resources.json'), JSON.stringify(registrations));
  const removeResource = (key: string) => fs.rename(path.join(resources.get(key)!, 'weights'), path.join(resources.get(key)!, 'removed'));
  const restoreResource = (key: string) => fs.rename(path.join(resources.get(key)!, 'removed'), path.join(resources.get(key)!, 'weights'));
  await removeResource('PREFLIGHT_MISSING');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'environment outcomes' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://environment', nodes: [...keys, 'NEXT'].map(key => {
    const repository = repositories.get(key === 'NEXT' ? 'MISSING' : key)!;
    return { key, goal: key, dependsOn: key === 'NEXT' ? ['MISSING'] : [], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['candidate'] },
      executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git(repository, 'rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant, checks: [{ name: 'candidate', argv: ['test', '-f', `${key}.txt`] }] } }] };
  }) } });
  const starts = new Map<string, number>(), probes = new Map<string, number>(), candidates = new Map<string, string[]>();
  const runtime: typeof import('../src/lib/task-graph/runtime-preflight') = require('../src/lib/task-graph/runtime-preflight');
  const prepare = runtime.prepareDeclaredRuntime;
  runtime.prepareDeclaredRuntime = async args => {
    const job = await prisma.taskGraphExecution.findFirst({ where: { node: { runId: run.id }, worktreePath: args.resourceWorkspace || args.workspace }, include: { node: true } });
    const key = job?.node.key;
    // Typed temporary failures are injected at the preparation boundary, not inferred from Agent text.
    if (key && (key === 'PREFLIGHT_TRANSIENT' || ['TRANSIENT', 'EXHAUST'].includes(key) && starts.has(key))) {
      const count = (probes.get(key) || 0) + 1; probes.set(key, count);
      if (key === 'EXHAUST' || count === 1) throw new RuntimePreparationError('transient', `temporary resource probe: ${key}`, [resources.get(key)!]);
    }
    return prepare(args);
  };
  const checkRuntime: typeof import('../src/lib/task-graph/check-environment') = require('../src/lib/task-graph/check-environment');
  const check = checkRuntime.runSandboxedGraphCheck;
  checkRuntime.runSandboxedGraphCheck = async (argv, cwd, env = {}, paths = []) => {
    const job = await prisma.taskGraphExecution.findFirst({ where: { node: { runId: run.id }, childTaskId: env.AP_GRAPH_SERVICE_TASK_ID || '' }, include: { node: true } });
    if (job?.node.key === 'CHECK_TRANSIENT' && !probes.has('CHECK_TRANSIENT')) {
      probes.set('CHECK_TRANSIENT', 1); throw new RuntimePreparationError('transient', 'temporary check resource probe', [resources.get('CHECK_TRANSIENT')!]);
    }
    return check(argv, cwd, env, paths);
  };
  const adapter = getHarnessAdapter('codex')!, original = { execute: adapter.execute, resume: adapter.resume };
  const execute: typeof adapter.execute = async args => {
    const { task, context } = args, key = task.name.split(' · ')[0], count = (starts.get(key) || 0) + 1;
    starts.set(key, count);
    if (count > 1) assert.equal('sessionId' in args ? args.sessionId : undefined, `native-${key}`, 'Continue the original Agent session');
    const before = git(context.workingDirectory, 'rev-parse', 'HEAD'); candidates.set(key, [...(candidates.get(key) || []), before]);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...context.taskEnvironment }, stdio: 'ignore' });
    context.onSpawn?.(child); await once(child, 'exit');
    if (count > 1) assert.equal(await fs.readFile(path.join(context.workingDirectory, `${key}.txt`), 'utf8'), 'saved candidate');
    await fs.writeFile(path.join(context.workingDirectory, `${key}.txt`), 'saved candidate');
    if (count === 1 && ['MISSING', 'CHECK_MISSING'].includes(key)) await removeResource(key);
    const result = key === 'PERMISSION' ? { status: 'blocked', blockerKind: 'permission_required', note: 'explicit permission needed' }
      : key === 'ENGINEERING' && count === 1 ? { status: 'blocked', blockerKind: 'missing_business_material', note: 'investigate approved inputs' }
      : count === 1 && ['MISSING', 'FALSE_REPORT', 'TRANSIENT', 'EXHAUST'].includes(key)
        ? { status: 'blocked', blockerKind: 'environment_failed', note: `Agent environment report: ${key}`, blockerCause: key === 'MISSING' ? 'missing_capability' : 'transient' }
        : { status: 'delivered', note: 'recovered', evidence: ['candidate'] };
    return { success: true, executionTime: 1, output: `TASK_GRAPH_IMPLEMENTATION ${JSON.stringify(result)}`, sessionId: `native-${key}`, sessionKind: 'codex_thread' };
  };
  adapter.execute = execute; adapter.resume = execute;
  const drain = async () => { const idle = new AbortController(); idle.abort(); await startTaskGraphCoordinator(idle.signal); };
  const jobs = () => prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, include: { node: true } });
  const until = async (done: (list: Awaited<ReturnType<typeof jobs>>) => boolean) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await runTaskGraphCycle(); await drain(); if (done(await jobs())) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Coordinator did not converge: ' + JSON.stringify((await jobs()).map(job => ({ key: job.node.key, status: job.status, progress: executionProgress(job.dispatchMetadata) }))));
  };
  const outcomes = async (executionId: string) => prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: 'execution_outcome', payload: { path: ['executionId'], equals: executionId } }, orderBy: { createdAt: 'asc' } });
  try {
    await until(list => ['FALSE_REPORT', 'TRANSIENT', 'PREFLIGHT_TRANSIENT', 'CHECK_TRANSIENT', 'ENGINEERING'].every(key => list.find(job => job.node.key === key)?.node.status === 'passed') &&
      ['MISSING', 'PREFLIGHT_MISSING', 'CHECK_MISSING', 'PERMISSION', 'EXHAUST'].every(key => list.find(job => job.node.key === key)?.status === 'attention'));
    const before = await jobs(), missing = before.find(job => job.node.key === 'MISSING')!, saved = executionProgress(missing.dispatchMetadata)!;
    assert.equal(starts.get('MISSING'), 1); assert.equal(saved.state, 'waiting_decision'); assert.equal(saved.platformAttempts, 0);
    assert.equal(saved.lastFailure?.code, 'environment_failed'); assert.equal(saved.lastFailure?.blockerCause, 'missing_capability');
    assert.equal(saved.lastFailure?.owner, 'platform'); assert.equal(saved.lastFailure?.requiresUserDecision, false);
    assert.match(saved.lastFailure?.detail || '', /缺少 OCR/); assert.deepEqual(saved.lastFailure?.affectedPaths, [path.join(resources.get('MISSING')!, 'weights')]);
    assert(saved.candidateCommit); assert.equal(git(missing.worktreePath!, 'show', `${saved.candidateCommit}:MISSING.txt`), 'saved candidate');
    const reports = await outcomes(missing.id);
    assert(reports.some(event => JSON.stringify(event.payload).includes('Agent environment report: MISSING')), 'Original report persists in the ledger');
    assert(!reports.some(event => JSON.stringify(event.payload).includes('"kind":"continue_work"')), 'Confirmed missing capability never becomes normal work');
    assert.equal(before.find(job => job.node.key === 'NEXT')?.node.status, 'planned');
    console.log('PASS real resource removal retains report, paths, candidate and platform ownership after one implementation');
    for (const key of ['PREFLIGHT_MISSING', 'CHECK_MISSING']) {
      const job = before.find(item => item.node.key === key)!, progress = executionProgress(job.dispatchMetadata)!;
      assert.equal(progress.lastFailure?.code, 'runtime_capability_missing'); assert(progress.lastFailure?.fingerprint);
      assert.equal(progress.phase, key.startsWith('CHECK') ? 'integrate' : 'prepare');
      assert.equal(starts.get(key) || 0, key.startsWith('CHECK') ? 1 : 0);
    }
    for (const key of ['TRANSIENT', 'PREFLIGHT_TRANSIENT', 'CHECK_TRANSIENT']) {
      assert.equal(executionProgress(before.find(job => job.node.key === key)!.dispatchMetadata)?.platformAttempts, 1);
    }
    const exhausted = before.find(job => job.node.key === 'EXHAUST')!, exhaustedProgress = executionProgress(exhausted.dispatchMetadata)!;
    assert.equal(exhaustedProgress.state, 'exhausted'); assert.equal(exhaustedProgress.platformAttempts, executionRetryLimits.platformAttempts);
    assert.equal(exhaustedProgress.lastFailure?.blockerCause, 'transient'); assert.equal(starts.get('EXHAUST'), 1, 'Failed startup retries never invoke a model');
    assert.equal((await outcomes(exhausted.id)).filter(event => JSON.stringify(event.payload).includes('"kind":"platform_retry"')).length, executionRetryLimits.platformAttempts + 1);
    console.log('PASS temporary failures recover within budget; persistent failure exhausts without resetting counters');
    for (const key of ['FALSE_REPORT', 'ENGINEERING']) {
      const job = before.find(item => item.node.key === key)!;
      assert.equal(starts.get(key), 2);
      assert.equal(executionProgress(job.dispatchMetadata)?.platformAttempts, 0, JSON.stringify({ key, progress: executionProgress(job.dispatchMetadata), outcomes: await outcomes(job.id) }));
      assert((await outcomes(job.id)).some(event => JSON.stringify(event.payload).includes('"kind":"continue_work"')));
    }
    const permission = before.find(job => job.node.key === 'PERMISSION')!;
    assert.equal(executionProgress(permission.dispatchMetadata)?.lastFailure?.requiresUserDecision, true); assert.equal(starts.get('PERMISSION'), 1);
    console.log('PASS false reports and engineering work resume original native sessions; permission still waits for the user');
    const frozenStarts = Array.from(starts);
    for (let n = 0; n < 3; n++) {
      await admitNode(missing.nodeId, { source: 'conditions', id: `unchanged-${n}` });
      await runTaskGraphCycle(); await drain();
    }
    assert.deepEqual(Array.from(starts), frozenStarts); assert.equal(executionProgress((await jobs()).find(job => job.id === missing.id)!.dispatchMetadata)?.candidateCommit, saved.candidateCommit);
    assert.deepEqual(executionProgress((await jobs()).find(job => job.id === missing.id)!.dispatchMetadata)?.lastFailure, saved.lastFailure, 'Condition checks retain the original failure; probe details have their own ledger event');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: missing.nodeId, kind: 'execution_conditions_ready' } }), 0);
    console.log('PASS unchanged conditions do not dispatch or release dependent work');
    await restoreResource('MISSING');
    const wake = { source: 'conditions' as const, id: 'resource-restored' };
    const admitted = await admitNode(missing.nodeId, wake);
    assert.equal(admitted.kind, 'admitted');
    assert.equal((await admitNode(missing.nodeId, wake)).kind, 'already_scheduled', 'Duplicate condition wake is idempotent');
    await until(list => list.find(job => job.node.key === 'NEXT')?.node.status === 'passed');
    const resumed = (await jobs()).find(job => job.id === missing.id)!;
    assert.equal(starts.get('MISSING'), 2); assert.equal(starts.get('NEXT'), 1); assert.equal(resumed.worktreePath, missing.worktreePath);
    assert.equal(candidates.get('MISSING')?.[1], saved.candidateCommit, 'Recovery starts at the exact saved candidate');
    assert.equal(executionProgress(resumed.dispatchMetadata)?.platformAttempts, 0);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: missing.nodeId, kind: 'execution_conditions_ready' } }), 1);
    const pins = await prisma.taskGraphEvent.findMany({ where: { nodeId: missing.nodeId, kind: 'runtime_snapshot_pinned' } });
    const identities = pins.map(event => (event.payload as { snapshot: { identity: string } }).snapshot.identity);
    assert(identities.length >= 2); assert.equal(new Set(identities).size, 1, 'Restored bytes use the same runtime identity');
    console.log('PASS restored resource resumes exact candidate and session once; downstream passes only after delivery');
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume;
    checkRuntime.runSandboxedGraphCheck = check; runtime.prepareDeclaredRuntime = prepare; platformModule.platformRepository = originalPlatform; globalThis.fetch = fetch;
    await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
