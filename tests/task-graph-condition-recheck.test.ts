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
import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { RuntimePreparationError } from '../src/lib/task-graph/runtime-preflight';
import { validationRuntimeDirectory } from '../src/lib/task-graph/acceptance-runtime';
import { getHarnessAdapter } from '../src/lib/harness';
import { setGraphRunPaused } from '../src/lib/task-graph/run-control';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'condition-recheck-')), repository = path.join(root, 'repo');
  await fs.mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  await fs.writeFile(path.join(repository, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename), notices = require('../src/lib/task-graph/feishu');
  notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  const adapter = getHarnessAdapter('codex')!, original = { execute: adapter.execute, resume: adapter.resume };
  const runtime: typeof import('../src/lib/task-graph/runtime-preflight') = require('../src/lib/task-graph/runtime-preflight');
  const prepare = runtime.prepareDeclaredRuntime;
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'condition recheck' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://conditions',
    nodes: ['RECHECK', 'PEER', 'NEXT'].map(key => ({ key, goal: key, dependsOn: key === 'NEXT' ? ['RECHECK', 'PEER'] : [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'),
        agentSelector: 'local:codex', instructions: key, launchConfig: { participant, checks: [] } }] })) } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'RECHECK' } } });
  let repaired = false, calls = 0, probes = 0, reviewCalls = 0;
  let reviewNodeId: string | undefined, reviewBroken = true, reviewRunId: string | undefined;
  runtime.prepareDeclaredRuntime = async args => {
    if (args.outputDirectory.startsWith(validationRuntimeDirectory(node.id) + path.sep)) {
      probes++;
      if (!repaired) throw new RuntimePreparationError('missing', 'required resource unavailable', [], 'fixed-resource');
    }
    if (reviewNodeId && reviewBroken && args.workspace.startsWith(validationRuntimeDirectory(reviewNodeId) + path.sep)) throw new RuntimePreparationError('missing', 'review browser unavailable', [], 'fixed-review-resource');
    return prepare(args);
  };
  const execute: typeof adapter.execute = async args => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    if (args.task.id.startsWith('task-graph-review-')) { reviewCalls++; return { success: true, output: 'TASK_GRAPH_REVIEW {"approved":true,"note":"fixed candidate verified"}', executionTime: 1 }; }
    if (args.task.name.startsWith('RECHECK')) calls++;
    await fs.writeFile(path.join(args.context.workingDirectory, args.task.name.split(' ')[0] + '.txt'), 'delivered');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"real saved worktree","evidence":["file"]}', sessionId: 'conditions-native', sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute;
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  const until = async (done: () => Promise<boolean>) => { for (let n = 0; n < 350; n++) { await runTaskGraphCycle(); if (await done()) { await drain(); return; } await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Condition change did not reach normal Coordinator work: ' + JSON.stringify({ nodes: await prisma.taskGraphNode.findMany({ where: { runId: reviewRunId || run.id }, include: { executions: true } }), events: await prisma.taskGraphEvent.findMany({ where: { runId: reviewRunId || run.id }, orderBy: { createdAt: 'desc' }, take: 6 }) })); };
  try {
    await until(async () => (await prisma.taskGraphNode.count({ where: { runId: run.id, key: 'PEER', status: 'delivered_unverified' } })) === 1);
    const before = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    const saved = executionProgress(before.dispatchMetadata)!;
    assert.equal(before.status, 'attention'); assert.equal(calls, 0); assert.ok(probes > 0);
    assert.equal(await prisma.taskGraphNode.count({ where: { runId: run.id, key: 'NEXT', status: 'planned' } }), 1);
    await prisma.taskGraphExecution.update({ where: { id: before.id }, data: { issueKind: 'retry_exhausted', dispatchMetadata: metadataWithProgress(before.dispatchMetadata,
      { ...saved, revision: saved.revision + 1, state: 'exhausted', platformAttempts: 77 }) } });
    await setGraphRunPaused({ runId: run.id, paused: true, requestId: 'pause', actorId: 'fixture', reason: 'user paused' });
    repaired = true;
    for (let i = 0; i < 3; i++) await runTaskGraphCycle();
    assert.equal(calls, 0, 'Resource readiness cannot override explicit user pause');
    await setGraphRunPaused({ runId: run.id, paused: false, requestId: 'unpause', actorId: 'fixture', reason: 'user unpaused' });
    await until(async () => (await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed_unverified');
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(calls, 1); assert.equal(after.worktreePath, before.worktreePath);
    assert.equal(executionProgress(after.dispatchMetadata)?.platformAttempts, 77, 'Lifetime counters remain truthful and do not revoke the approved job');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'execution_conditions_ready' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'conversation_review_recovery_requested' } }), 0);
    const reviewRun = await createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: parent.id + ':review', definition: { specRef: 'fixture://review-conditions', nodes: [{
      key: 'REVIEW', goal: 'review condition', dependsOn: [], executionMode: 'lean', acceptance: { mode: 'agent', reviewerId: 'local:codex', checks: ['file'], reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } },
      executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'review fixed deliverable', launchConfig: { participant, checks: [{ name: 'file', argv: ['node', '-e', "require('fs').accessSync('REVIEW.txt')"] }] } }],
    }] } });
    reviewRunId = reviewRun.id;
    const reviewNode = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: reviewRun.id, key: 'REVIEW' } } }); reviewNodeId = reviewNode.id;
    await until(async () => (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: reviewNode.id } })).status === 'attention');
    const reviewJob = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: reviewNode.id } });
    assert.ok(reviewJob.commit); assert.equal(reviewCalls, 0, 'Unavailable reviewer environment must not invoke a model');
    const reviewBefore = executionProgress(reviewJob.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: reviewJob.id }, data: { dispatchMetadata: metadataWithProgress(reviewJob.dispatchMetadata, { ...reviewBefore, platformAttempts: 77, revision: reviewBefore.revision + 1 }) } });
    reviewBroken = false;
    await until(async () => (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: reviewNode.id } })).status === 'passed');
    const reviewed = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reviewJob.id } });
    assert.equal(reviewed.commit, reviewJob.commit); assert.equal(reviewCalls, 1);
    assert.equal(executionProgress(reviewed.dispatchMetadata)?.platformAttempts, 77);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: reviewNode.id, kind: 'verification_recovery_requested' } }), 1);
    console.log('Review conditions: original fixed candidate independently verified after platform repair; historical count 77 retained; implementation not repeated');
    console.log('Conditions: unavailable platform resource launches no model; independent peer delivers; successful recheck reclaims original candidate/worktree despite old count 77; user pause and downstream dependency remain enforced');
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume; runtime.prepareDeclaredRuntime = prepare;
    if (reviewRunId) await prisma.taskGraphRun.delete({ where: { id: reviewRunId } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
