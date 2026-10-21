import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { parseImplementationResult } from '../src/lib/task-graph/implementation-result';
import { receiveGraphTaskMessage } from '../src/lib/task-graph/conversation-inbox';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function main() {
  assert.equal(parseImplementationResult('已保存一部分，接下来运行测试。', { conversation: true }).status, 'working', 'An ordinary turn is neither delivery nor a request to wait');
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'persistent-agent-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  writeFileSync(path.join(repository, 'source'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.AP_WORKSPACE_ROOT = path.join(root, 'central');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  const human = await prisma.user.create({ data: { username: root, passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'persistent work', ownerUserId: human.id } });
  const calls: { key: string; session: string | null; directory: string }[] = [];
  let workTurns = 0, emptyTurns = 0;
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId: args.task.id }, include: { node: true } });
    const session = 'sessionId' in args ? args.sessionId : null;
    calls.push({ key: job.node.key, session, directory: args.context.workingDirectory });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    const reply = (output: string) => ({ success: true, output, sessionId: `native-${job.node.key}`, sessionKind: 'codex_thread', executionTime: 1 });
    if (job.node.key === 'IDLE') { emptyTurns++; return reply('TASK_GRAPH_IMPLEMENTATION {"status":"working","note":"继续尝试"}'); }
    if (job.node.key === 'NEXT') return reply('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"consumer done","evidence":["source"]}');
    workTurns++;
    if (workTurns > 1) assert.equal(session, 'native-WORK', 'Every normal turn must resume the original native session');
    if (workTurns === 1) { writeFileSync(path.join(args.context.workingDirectory, 'half'), 'saved'); return reply('已保存一部分，接下来运行测试。'); }
    if (workTurns === 2) { assert.equal(readFileSync(path.join(args.context.workingDirectory, 'half'), 'utf8'), 'saved');
      writeFileSync(path.join(args.context.workingDirectory, 'tested'), 'fixed'); return reply('TASK_GRAPH_IMPLEMENTATION {"status":"working","note":"测试已修复，继续核对"}'); }
    if (workTurns === 3) return reply('TASK_GRAPH_IMPLEMENTATION {"status":"waiting_for_user","note":"最终尺寸是多少？"}');
    const prompt = 'continuationMessage' in args ? args.continuationMessage : args.task.description || '';
    assert.match(prompt, /尺寸45/); writeFileSync(path.join(args.context.workingDirectory, 'done'), '45');
    return reply('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implemented","evidence":["done=45"]}');
  };
  adapter.execute = execute; adapter.resume = execute;
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://persistent-turns', nodes: ['WORK', 'IDLE', 'NEXT'].map(key => ({ key, goal: key, dependsOn: key === 'NEXT' ? ['WORK'] : [],
      executionMode: key === 'WORK' ? 'lean' : 'implement', acceptance: { mode: 'automatic', checks: key === 'WORK' ? ['done'] : [] },
      executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'fixture',
        launchConfig: { participant, checks: key === 'WORK' ? [{ name: 'done', argv: ['node', '-e', "require('assert').equal(require('fs').readFileSync('done','utf8'),'45')"] }] : [] } }] })),
  } });
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  const until = async (predicate: () => Promise<boolean>) => {
    for (let index = 0; index < 250; index++) { await runTaskGraphCycle(); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Persistent fixture did not progress: ' + JSON.stringify(await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } } })));
  };
  try {
    await until(async () => workTurns === 3 && (await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'WORK' } } })).status === 'attention');
    await drain();
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'WORK' } } });
    assert.equal(executionProgress(job.dispatchMetadata)?.state, 'waiting_for_user');
    for (let i = 0; i < 3; i++) await runTaskGraphCycle();
    assert.equal(workTurns, 3, 'An explicit user question must not cause automatic empty turns');
    const answer = { taskId: job.childTaskId!, sourceId: 'answer-once', actorOrigin: 'platform' as const, actorId: human.id, content: '尺寸45' };
    await receiveGraphTaskMessage(answer); await receiveGraphTaskMessage(answer);
    await until(async () => (await prisma.taskGraphNode.count({ where: { runId: run.id, key: 'WORK', status: 'passed' } })) === 1);
    await drain();
    const complete = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(complete.dispatchMetadata)!;
    assert.equal(workTurns, 4); assert.equal(progress.repairAttempts + progress.formatAttempts + progress.platformAttempts, 0);
    assert.equal(new Set(calls.filter(call => call.key === 'WORK').map(call => call.directory)).size, 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'conversation_input_bound' } }), 1);
    assert.ok(await prisma.taskGraphNode.count({ where: { runId: run.id, key: 'NEXT', status: { not: 'planned' } } }));
    await until(async () => (await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'IDLE' } } })).status === 'attention');
    await drain(); const before = emptyTurns;
    for (let i = 0; i < 4; i++) await runTaskGraphCycle();
    assert.equal(emptyTurns, before, 'Identical work/input cannot spin forever');
    const idle = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'IDLE' } } });
    assert.equal(executionProgress(idle.dispatchMetadata)?.formatAttempts, 0, 'No-progress protection does not consume a result-format budget');
    console.log('T1 real Coordinator: multiple normal turns, native Session/Worktree, explicit wait/reply, input dedupe, checks and successor release; unchanged turns stop without revoking approval');
  } finally { await drain(); adapter.execute = original.execute; adapter.resume = original.resume;
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
