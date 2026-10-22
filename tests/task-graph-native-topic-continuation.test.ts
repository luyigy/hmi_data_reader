// Opt-in paid model smoke. Only the Feishu transport is a fixture; Codex is real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphRoomMessage } from '../src/lib/task-graph/conversation-inbox';
import { getHarnessAdapter } from '../src/lib/harness';

async function main() {
  if (process.env.TASK_GRAPH_NATIVE_TOPIC !== '1') throw new Error('Set TASK_GRAPH_NATIVE_TOPIC=1 for real Codex/model calls');
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'native-topic-'));
  const repository = path.join(root, 'project'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Native smoke'); git('config', 'user.email', 'smoke@example.test');
  writeFileSync(path.join(repository, 'answer.js'), 'module.exports = () => null;\n');
  git('add', '.'); git('commit', '-m', 'Initial implementation awaiting material');
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const feishu = createRequire(__filename)('../src/lib/task-graph/feishu');
  // No external messages or production bindings are created by this isolated smoke.
  feishu.postGraphParentProgress = async () => {};
  feishu.postGraphChildProgress = async () => {};
  const adapter = getHarnessAdapter('codex'); assert.ok(adapter);
  const original = { execute: adapter.execute, resume: adapter.resume };
  const resumeNative = adapter.resume; assert.ok(resumeNative);
  const turns: { kind: string; requestedSession?: string; returnedSession?: string; success: boolean }[] = [];
  adapter.execute = async args => {
    const result = await original.execute(args);
    turns.push({ kind: 'execute', returnedSession: result.sessionId, success: result.success });
    return result;
  };
  adapter.resume = async args => {
    const result = await resumeNative(args);
    turns.push({ kind: 'resume', requestedSession: args.sessionId, returnedSession: result.sessionId, success: result.success });
    return result;
  };
  const human = await prisma.user.create({ data: { username: root, passwordHash: 'fixture-only', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'Native Topic continuation smoke', ownerUserId: human.id } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://native-topic-continuation', nodes: [{ key: 'WORK', goal: 'Implement answer using the user-provided value',
      dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{
        key: 'code', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex',
        instructions: '实现 answer.js：导出的函数返回用户提供的数值。当前没有数值材料，不得猜测；先问用户数值，输出 TASK_GRAPH_IMPLEMENTATION {"status":"waiting_for_user","note":"请提供返回数值"} 并结束这一轮，不改代码。后续用户给出数值后，修改 answer.js，运行 node 验证实际返回值，输出 delivered 结构化结论和真实证据。只处理这个文件，不使用恢复命令、不要求额外批准。',
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' },
          checks: [{ name: 'answer', argv: ['node', '-e', "require('assert').equal(require('./answer')(),42)"] }] },
      }] }],
  } });
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  const job = () => prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) { await runTaskGraphCycle(); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
    throw new Error('Native continuation deadline: ' + JSON.stringify({ job: await job(), turns }));
  };
  try {
    await until(async () => executionProgress((await job()).dispatchMetadata)?.state === 'waiting_for_user');
    await drain(); const before = await job();
    assert.equal(turns.length, 1); assert.equal(turns[0].success, true); assert.ok(turns[0].returnedSession);
    assert.ok(before.childTaskId); assert.ok(before.worktreePath);
    assert.equal(readFileSync(path.join(before.worktreePath, 'answer.js'), 'utf8'), 'module.exports = () => null;\n');
    const room = await prisma.liveRoom.findFirst({ where: { sourceTaskId: before.childTaskId } }) ||
      await prisma.liveRoom.create({ data: { title: 'Original Ticket Topic', sourceTaskId: before.childTaskId } });
    const actorId = 'fixture-user-native-topic';
    const metadata = JSON.stringify({ source: 'feishu', feishuSenderOpenId: actorId,
      feishuMessageId: 'om_fixture_answer_42', feishuChatId: 'oc_fixture', feishuThreadId: 'omt_fixture_original' });
    const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '返回数值使用42，请按原任务完成。', metadata } });
    assert.equal(await receiveGraphRoomMessage(room.id, message.id), true);
    await until(async () => (await job()).status === 'integrated'); await drain();
    const after = await job(); const progress = executionProgress(after.dispatchMetadata); assert.ok(progress);
    assert.equal(after.worktreePath, before.worktreePath);
    assert.equal(turns.length, 2); assert.equal(turns[1].kind, 'resume'); assert.equal(turns[1].success, true);
    assert.equal(turns[1].requestedSession, turns[0].returnedSession);
    assert.equal(turns[1].returnedSession, turns[0].returnedSession);
    const code = readFileSync(path.join(after.worktreePath!, 'answer.js'), 'utf8'); assert.notEqual(code, 'module.exports = () => null;\n');
    execFileSync('node', ['-e', "require('assert').equal(require('./answer')(),42)"], { cwd: after.worktreePath!, stdio: 'pipe' });
    const events = await prisma.taskGraphEvent.findMany({ where: { runId: run.id }, select: { kind: true } });
    assert.equal(events.filter(e => e.kind === 'conversation_input_bound').length, 1);
    assert.equal(events.filter(e => e.kind === 'conversation_review_recovery_requested').length, 0);
    assert.equal(progress.repairAttempts + progress.platformAttempts + progress.formatAttempts, 0);
    const evidence = { transport: 'persisted original Topic message fixture, not a live Feishu user message',
      harness: 'real Codex adapter and configured model, no response fixture', runId: run.id, executionId: before.id,
      roomId: room.id, roomMessageId: message.id, turns, code, commit: after.commit,
      diff: git('show', '--format=fuller', after.commit!, '--', 'answer.js'),
      checksPassed: true, recoveryCommands: 0, sameWorktree: true, originalNativeSession: turns[0].returnedSession };
    if (process.env.NATIVE_TOPIC_EVIDENCE) writeFileSync(process.env.NATIVE_TOPIC_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume;
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect();
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
