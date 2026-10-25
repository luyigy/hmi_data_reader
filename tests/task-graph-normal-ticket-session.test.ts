import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { rotateTaskSession } from '../src/lib/acpx/session';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage, deliverConversationSteering } from '../src/lib/task-graph/conversation-inbox';
import { getHarnessAdapter } from '../src/lib/harness';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'normal-ticket-')), repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  writeFileSync(path.join(repo, 'value'), '1'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'inputs');
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  const adapter = getHarnessAdapter('codex')!, saved = { execute: adapter.execute, resume: adapter.resume };
  let turns = 0, originalDirectory = '', testOutput = '', steeringCount = 0;
  const native = 'normal-ticket-original-native';
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    turns++;
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    assert.notEqual(args.context.permissionConfig?.sandboxMode, 'read-only');
    assert.equal(args.context.permissionConfig?.profile, 'dev_local');
    const directory = args.context.workingDirectory;
    if (turns === 1) {
      originalDirectory = directory;
      return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"waiting_for_user","note":"请补充期望值"}', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 };
    }
    if (turns >= 6) {
      assert.equal('sessionId' in args ? args.sessionId : null, turns === 6 ? null : 'reset-native');
      assert.equal(directory, originalDirectory);
      assert.equal(readFileSync(path.join(directory, 'value'), 'utf8'), '42');
      return { success: true, output: '重置后的正常答复', sessionId: 'reset-native', sessionKind: 'codex_thread', executionTime: 1 };
    }
    assert.equal('sessionId' in args ? args.sessionId : null, native);
    assert.equal(directory, originalDirectory);
    const prompt = 'continuationMessage' in args ? args.continuationMessage : args.task.description || '';
    if (turns === 2) {
      assert.match(prompt, /当前值是多少？记住目标是42，只解释，先别改/);
      assert.equal(readFileSync(path.join(directory, 'value'), 'utf8'), '1');
      return { success: true, output: '当前值是1，已记住目标42，等你补充。', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 };
    }
    if (turns >= 4) {
      assert.match(prompt, /再解释一次/);
      if (turns === 4) return { success: false, error: 'Selected model is at capacity. Please try again.', executionTime: 1 };
      assert.equal(turns, 5, 'A recovered input is processed once');
      return { success: true, output: '值已改为42，本轮仅解释。', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 };
    }
    assert.equal(turns, 3, 'No turn may be dispatched without fresh input');
    assert.match(prompt, /按上一轮目标修改并测试/);
    const detach = args.context.streamCallbacks?.onSteeringReady?.(async (_id, text) => {
      assert.match(text, /运行中补充：保持目标42/); steeringCount++; return 'accepted';
    });
    await receiveGraphTaskMessage({ taskId: args.task.id, actorId: human.id, actorOrigin: 'platform', sourceId: 'active-steering', content: '运行中补充：保持目标42' });
    await deliverConversationSteering(); await deliverConversationSteering(); detach?.();
    writeFileSync(path.join(directory, 'value'), '42');
    testOutput = execFileSync(process.execPath, ['-e', "require('assert/strict').equal(require('fs').readFileSync('value','utf8'),'42');console.log('value behavior passed')"], { cwd: directory, encoding: 'utf8' }).trim();
    return { success: true, output: '已按上一轮目标改为42，行为测试通过，等待你核对。', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute;
  const human = await prisma.user.create({ data: { username: root, passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'normal ticket fixture', ownerUserId: human.id } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://normal-ticket', nodes: [{ key: 'TICKET', goal: 'set value', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
      executions: [{ key: 'code', repository: repo, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'set value to approved input',
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [] } }] }] } });
  const job = () => prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  const waitForTurn = async (count: number) => {
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      if (turns >= count && (await job()).status === 'attention') { await drain(); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Turn did not reach a saved waiting state');
  };
  try {
    await waitForTurn(1);
    const first = await job();
    const firstRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: first.taskRunId! } });
    const input = { taskId: first.childTaskId!, actorId: human.id, actorOrigin: 'platform' as const };
    const roundOne = { ...input, sourceId: 'first-user-round', content: '当前值是多少？记住目标是42，只解释，先别改' };
    await Promise.all([receiveGraphTaskMessage(roundOne), receiveGraphTaskMessage(roundOne)]);
    await waitForTurn(2);
    assert.equal(turns, 2, 'An ordinary answer must wait for the next user message');
    const answerOnly = await job();
    assert.equal(executionProgress(answerOnly.dispatchMetadata)!.candidateCommit, executionProgress(first.dispatchMetadata)!.candidateCommit, 'An unchanged answer cannot manufacture a new candidate');
    assert.equal(answerOnly.commit, null);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: first.nodeId } })).status, 'attention');
    for (let n = 0; n < 4; n++) await runTaskGraphCycle();
    await drain(); assert.equal(turns, 2, 'Condition polling must not re-dispatch an answered conversation');
    await receiveGraphTaskMessage({ ...input, sourceId: 'second-user-round', content: '按上一轮目标修改并测试' });
    await waitForTurn(3);
    for (let n = 0; n < 4; n++) await runTaskGraphCycle();
    await drain(); assert.equal(turns, 3);
    const last = await job(), progress = executionProgress(last.dispatchMetadata)!;
    assert.equal(last.worktreePath, first.worktreePath);
    assert.equal(progress.state, 'waiting_for_user'); assert.equal(progress.waitingKind, 'answered');
    assert.equal(last.commit, null, 'Conversational work is not an accepted delivery');
    assert.equal(testOutput, 'value behavior passed');
    assert.equal(steeringCount, 1, 'Running input steers the current turn exactly once without another card or admission');
    assert.equal(readFileSync(path.join(originalDirectory, 'value'), 'utf8'), '42');
    const runs = await prisma.taskRun.findMany({ where: { taskId: first.childTaskId! } });
    assert.equal(new Set(runs.map(run => JSON.parse(run.controlMetadata || '{}').graphReplyIdentity)).size, 3, 'Each user round has its own stable reply identity, without a preliminary read-only card');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_turn_scheduled' } }), 2);
    assert.equal(runs.length, 3); assert.ok(runs.every(run => run.taskSessionId === firstRun.taskSessionId));
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_input_bound' } }), 2);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 0);
    await receiveGraphTaskMessage({ ...input, sourceId: 'retry-user-round', content: '再解释一次，不要修改' });
    await waitForTurn(5);
    const attempts = await prisma.taskRun.findMany({ where: { taskId: first.childTaskId! }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    assert.equal(attempts.length, 5, 'A transient native failure creates one recovery attempt without a read-only turn');
    assert.equal(attempts[3].status, 'failed'); assert.equal(attempts[4].status, 'completed');
    assert.equal(JSON.parse(attempts[3].controlMetadata!).graphReplyIdentity, JSON.parse(attempts[4].controlMetadata!).graphReplyIdentity, 'Native recovery preserves the original user card identity');
    assert.notEqual(JSON.parse(attempts[2].controlMetadata!).graphReplyIdentity, JSON.parse(attempts[3].controlMetadata!).graphReplyIdentity);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.id } })).commit, null);
    const reset = await rotateTaskSession(first.childTaskId!, { metadata: { source: 'feishu_new_session', rotationKey: 'full-reset', targetMemberId: null, rotationCheckpoint: 'completed' } });
    await receiveGraphTaskMessage({ ...input, sourceId: 'reset-first', content: '新会话只解释当前值' });
    await waitForTurn(6);
    await receiveGraphTaskMessage({ ...input, sourceId: 'reset-second', content: '继续解释，不修改' });
    await waitForTurn(7);
    const resetRuns = await prisma.taskRun.findMany({ where: { taskId: first.childTaskId!, taskSessionId: reset.id } });
    assert.equal(resetRuns.length, 2); assert.ok(resetRuns.every(run => run.status === 'completed'));
    assert.equal((await job()).commit, null, 'Reset does not deliver a candidate');
    console.log(JSON.stringify({ fixture: true, turns, resetFreshThenResume: true, sameSession: true, sameWorktree: true, inputReceipts: 2, testOutput, candidate: progress.candidateCommit, accepted: false }));
  } finally {
    await drain(); adapter.execute = saved.execute; adapter.resume = saved.resume;
    await prisma.taskGraphRun.delete({ where: { id: graph.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
