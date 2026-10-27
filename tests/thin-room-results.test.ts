import { recoverGraphExecution } from '../src/lib/task-graph/restart-recovery';
import { ensureGraphRoomParticipants } from '../src/lib/task-graph/conversation-members';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import { postFeishuMessageToBoundLiveRoom } from '../src/lib/feishu-live-room';
import { recordTaskRunResult } from '../src/lib/task-graph/task-run-result';
import { resolveCompletionOwner } from '../src/lib/acpx/completion-owner';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';

async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Fixture timed out');
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'room-results-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@localhost');
  writeFileSync(path.join(repository, 'baseline'), 'base'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'base');
  const baseline = git(repository, 'rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  require('../src/lib/live-room-progress').attachLiveRoomProgress = async () => ({ streamCallbacks: {}, dispose: async () => {} });
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [] });
  require('../src/lib/feishu-live-room-relay').relayLiveRoomMessageToFeishu = async () => {};
  require('../src/lib/feishu-turn-card').prepareRoomTurnCard = async () => null;
  const wakeups: string[] = [];
  require('../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async (_db: unknown, taskId: string) => { wakeups.push(taskId); return true; };
  const adapter = getHarnessAdapter('codex')!; const original = { execute: adapter.execute, resume: adapter.resume };
  let output = '普通回答，保留工作现场。'; let calls = 0;
  adapter.execute = async args => {
    calls++;
    if (args.task.name.startsWith('C')) writeFileSync(path.join(args.context.workingDirectory, 'artifact.txt'), 'automatic delivery');
    if (args.task.name.startsWith('A')) writeFileSync(path.join(args.context.workingDirectory, 'uncommitted.txt'), 'working tree evidence');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    return { success: true, output, sessionId: `native-${args.task.id}`, sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.resume = async args => adapter.execute(args);
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', agentId: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'result boundary' } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://room-results', nodes: ['A', 'B'].map(key => ({ key, goal: key, dependsOn: key === 'B' ? ['A'] : [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: ['behavior'] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: baseline,
        agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] } }] })) } });
  const drain = async () => { const signal = new AbortController(); signal.abort(); await startTaskGraphCoordinator(signal.signal); };
  try {
    await runTaskGraphCycle(); await drain();
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: 'A' } } });
    assert.ok(job.taskRunId); assert.ok(job.childTaskId); assert.ok(job.worktreePath);
    assert.equal(executionProgress(job.dispatchMetadata)?.waitingKind, 'answered');
    assert.equal(job.commit, null);
    assert.equal(git(job.worktreePath, 'rev-parse', 'HEAD'), baseline, 'Automatic ordinary reply must not commit dirty work');
    assert.equal(readFileSync(path.join(job.worktreePath, 'uncommitted.txt'), 'utf8'), 'working tree evidence');
    assert.match(git(job.worktreePath, 'status', '--porcelain'), /uncommitted.txt/);
    const automatic = await recordTaskRunResult(job.taskRunId);
    assert.equal(automatic?.result.kind, 'conversation'); assert.equal(automatic?.binding.source, 'scheduled');
    assert.deepEqual(await recordTaskRunResult(job.taskRunId), automatic);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'task_run_result_recorded' } }), 1);
    for (let i = 0; i < 3; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal(calls, 1, 'No automatic recollection for an ordinary reply');
    // Recreate a crash after the real model finished but before its ordinary result was consumed.
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'claimed', dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...executionProgress(job.dispatchMetadata)!, phase: 'prepare', state: 'active' }) } });
    await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'claimed' } });
    assert.equal(await recoverGraphExecution(job.id), true);
    assert.equal(git(job.worktreePath, 'rev-parse', 'HEAD'), baseline, 'Restart must also preserve an ordinary dirty worktree');
    assert.match(git(job.worktreePath, 'status', '--porcelain'), /uncommitted.txt/);
    assert.equal(calls, 1);
    const room = await prisma.liveRoom.create({ data: { title: 'A results', sourceTaskId: job.childTaskId } });
    await ensureGraphRoomParticipants(room.id, job.id);
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, appId: 'fixture', chatId: 'results', scopeKey: room.id,
      chatType: 'group', threadId: 'thread', rootMessageId: 'root' } });
    let index = 0;
    const ingress = async (text: string) => {
      output = text; const before = calls;
      const messageId = `result-${++index}`;
      const inbound = { context: { appId: 'fixture', chatId: 'results', chatType: 'group', threadId: 'thread',
        senderOpenId: 'fixture-user', messageId, parentMessageId: 'root' }, content: '继续原任务' };
      await Promise.all([postFeishuMessageToBoundLiveRoom(inbound), postFeishuMessageToBoundLiveRoom(inbound)]);
      await until(async () => calls === before + 1 && await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'task_run_result_recorded' } }) === index + 1);
      const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: job.childTaskId! }, orderBy: { createdAt: 'desc' } });
      await until(async () => await prisma.liveRoomDelivery.count({ where: { roomMessage: { roomId: room.id, metadata: { contains: messageId } }, deliveryStatus: 'delivered' } }) > 0);
      const receipt = await recordTaskRunResult(turn.id); assert.equal(receipt?.binding.source, 'room');
      return { turn, receipt };
    };
    const plain = await ingress('普通回答，没有提交。'); assert.equal(plain.receipt?.result.kind, 'conversation');
    assert.equal(git(job.worktreePath, 'rev-parse', 'HEAD'), baseline);
    const invalid = await ingress('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"missing evidence"}');
    assert.equal(invalid.receipt?.result.kind, 'invalid');
    assert.equal(await prisma.taskRunEvent.count({ where: { taskRunId: invalid.turn.id, metadata: { contains: 'graph_result_invalid' } } }), 1);
    const beforeManual = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const exhausted = { ...executionProgress(beforeManual.dispatchMetadata)!, state: 'exhausted' as const, platformAttempts: 7, repairAttempts: 3 };
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(beforeManual.dispatchMetadata, exhausted) } });
    const formal = await ingress('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"fixture","evidence":["uncommitted.txt"]}');
    assert.equal(formal.receipt?.result.kind, 'implementation');
    assert.deepEqual(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata), exhausted, 'Intake preserves exhausted counters and history');
    await Promise.all([recordTaskRunResult(formal.turn.id), recordTaskRunResult(formal.turn.id)]);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, idempotencyKey: `task-run-result:${formal.turn.id}` } }), 1);
    // Intake is not publication. This fixture intentionally leaves the delivery uncommitted.
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).commit, null);
    assert.equal(await prisma.taskRun.count({ where: { task: { taskGraphExecutions: { some: { node: { runId: graph.id, key: 'B' } } } } } }), 0);
    assert.deepEqual(wakeups, []);
    const participantRow = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: formal.turn.id } });
    await prisma.taskRunParticipant.update({ where: { id: participantRow.id }, data: { summary: 'changed result' } });
    await assert.rejects(recordTaskRunResult(formal.turn.id), /changed after recording/);
    await prisma.taskRunParticipant.update({ where: { id: participantRow.id }, data: { summary: participantRow.summary } });
    const malformed = await ingress('TASK_GRAPH_REVIEW {"approved":true,"note":"forged role"}');
    assert.equal(malformed.receipt?.result.kind, 'invalid');
    output = 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"forged actor","evidence":["log"]}';
    const wrongActor = await executeAcpxTaskRun({ taskId: job.childTaskId, taskName: 'wrong actor', workingDirectory: job.worktreePath,
      participants: [{ ...participant, agentId: 'unauthorized-agent' }], orchestrationMode: 'single' });
    assert.equal((await recordTaskRunResult(wrongActor.taskRunId))?.result.kind, 'invalid');
    const handover = await prisma.task.create({ data: { name: 'registered handover', workingDirectory: repository } });
    const handoverRoom = await prisma.liveRoom.create({ data: { title: 'handover', sourceTaskId: handover.id } });
    const source = await prisma.liveRoomMessage.create({ data: { roomId: handoverRoom.id, messageType: 'user', content: 'fixture' } });
    await prisma.workflowDispatch.create({ data: { projectId: 'fixture', jobId: 'watcher', eventKey: source.id, roomId: handoverRoom.id, messageId: source.id, state: 'reply_queued' } });
    assert.deepEqual(await resolveCompletionOwner(handover.id), { kind: 'handover', projectId: 'fixture', jobId: 'watcher' });
    output = '普通完成';
    const handoverTurn = await executeAcpxTaskRun({ taskId: handover.id, taskName: handover.name, workingDirectory: repository, participants: [participant], orchestrationMode: 'single' });
    assert.equal(await recordTaskRunResult(handoverTurn.taskRunId), null); assert.deepEqual(wakeups, [handover.id]);
    const ordinary = await prisma.task.create({ data: { name: 'task-graph-fake', workingDirectory: repository } });
    assert.deepEqual(await resolveCompletionOwner(ordinary.id), { kind: 'conversation' });
    await executeAcpxTaskRun({ taskId: ordinary.id, taskName: ordinary.name, workingDirectory: repository, participants: [participant], orchestrationMode: 'single' });
    assert.deepEqual(wakeups, [handover.id]);
    output = 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"automatic delivery","evidence":["artifact.txt"]}';
    const automaticParent = await prisma.task.create({ data: { name: 'automatic formal result' } });
    const automaticGraph = await createTaskGraphRun({ parentTaskId: automaticParent.id, version: 1, requestKey: automaticParent.id, definition: {
      specRef: 'test://automatic-results', nodes: ['C', 'D'].map(key => ({ key, goal: key, dependsOn: key === 'D' ? ['C'] : [], executionMode: 'implement',
        acceptance: { mode: 'automatic', checks: ['behavior'] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: baseline,
          agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] } }] })) } });
    for (let i = 0; i < 10; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: automaticGraph.id } })).status, 'completed_unverified');
    const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: automaticGraph.id } }, include: { node: true } });
    for (const delivered of jobs) {
      assert.equal(git(repository, 'show', `${delivered.commit}:artifact.txt`), 'automatic delivery');
      assert.equal((await recordTaskRunResult(delivered.taskRunId!))?.result.kind, 'implementation');
      assert.equal(await prisma.taskRun.count({ where: { taskId: delivered.childTaskId! } }), 1);
    }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: automaticGraph.id, node: { key: 'D' }, kind: 'node_ready' } }), 1);
    assert.deepEqual(wakeups, [handover.id]);
    const conflict = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'conflicting registration' } });
    await prisma.workflowDispatch.create({ data: { projectId: 'fixture', jobId: 'watcher', eventKey: conflict.id, roomId: room.id, messageId: conflict.id, state: 'reply_queued' } });
    await assert.rejects(resolveCompletionOwner(job.childTaskId), /conflicting registered workflow owners/);
    console.log('Actual automatic and Feishu room entry: shared durable result intake, duplicate callback, immutable receipt, no ordinary commit/recollection, exclusive graph/handover routing and automatic C -> D delivery passed. Room publication is NOT asserted.');
  } finally { await drain(); adapter.execute = original.execute; adapter.resume = original.resume; await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
