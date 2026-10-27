import { publishRoomResult, recoverRoomResults } from '../src/lib/task-graph/room-result-publication';
import { recoverGraphExecution } from '../src/lib/task-graph/restart-recovery';
import { ensureGraphRoomParticipants } from '../src/lib/task-graph/conversation-members';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, approveHumanNode } from '../src/lib/task-graph/store';
import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import { postFeishuMessageToBoundLiveRoom } from '../src/lib/feishu-live-room';
import { recordTaskRunResult } from '../src/lib/task-graph/task-run-result';
import { resolveCompletionOwner } from '../src/lib/acpx/completion-owner';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import type { ProjectsConfig } from '../src/lib/scheduled-jobs/project-config';

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
  const config: ProjectsConfig = { projects: [{ id: 'fixture', name: 'watcher fixture',
    path: path.join(root, 'watcher-project'), ref: 'refs/heads/main',
    feishu: { chat_id: 'fixture', approver_open_ids: [] }, jobs: [
      { id: 'watcher', type: 'workflow_watcher', enabled: false, mode: 'shadow', schedule: '* * * * *', config: {} },
      { id: 'other-watcher', type: 'workflow_watcher', enabled: false, mode: 'shadow', schedule: '* * * * *', config: {} },
      { id: 'counter', type: 'long_file_detector', enabled: false, mode: 'shadow', schedule: '* * * * *', config: {} },
    ] }] };
  mkdirSync(config.projects[0].path);
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => config;
  require('../src/lib/feishu-live-room-relay').relayLiveRoomMessageToFeishu = async () => {};
  require('../src/lib/feishu-turn-card').prepareRoomTurnCard = async () => null;
  const wakeups: string[] = [];
  require('../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async (_db: unknown, taskId: string) => { wakeups.push(taskId); return true; };
  const adapter = getHarnessAdapter('codex')!; const original = { execute: adapter.execute, resume: adapter.resume };
  let output = '普通回答，保留工作现场。'; let calls = 0; let commitRoom = false; let reviewOutput: string | null = null;
  adapter.execute = async args => {
    calls++;
    if (args.task.name.startsWith('C')) writeFileSync(path.join(args.context.workingDirectory, 'artifact.txt'), 'automatic delivery');
    if (/^[RSHI] · /.test(args.task.name) && !args.task.name.includes('验收复核')) writeFileSync(path.join(args.context.workingDirectory, args.task.name.split(' · ')[0] + '.txt'), args.task.id);
    if (args.task.name.startsWith('A')) writeFileSync(path.join(args.context.workingDirectory, 'uncommitted.txt'), 'working tree evidence');
    if (commitRoom && git(args.context.workingDirectory, 'status', '--porcelain')) {
      git(args.context.workingDirectory, 'add', '.'); git(args.context.workingDirectory, 'commit', '-m', 'Agent tested delivery');
    }
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    return { success: true, output: args.task.name.includes('验收复核') ? reviewOutput || output : output, sessionId: `native-${args.task.id}`, sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.resume = async args => adapter.execute(args);
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', agentId: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'result boundary' } });
  const fixtureRooms: string[] = [];
  const fixtureParents = [parent.id];
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    deliveryContract: 'agent_owned_v1', specRef: 'test://room-results', nodes: ['A', 'B'].map(key => ({ key, goal: key, dependsOn: key === 'B' ? ['A'] : [], executionMode: 'lean',
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
    fixtureRooms.push(room.id);
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
    commitRoom = true;
    const publicationModule = require('../src/lib/task-graph/room-result-publication');
    const actualPublisher = publicationModule.publishRoomResult;
    publicationModule.publishRoomResult = async () => undefined;
    const delivered = await ingress('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"tested committed source","evidence":["uncommitted.txt"],"ticketVerification":{"approved":true,"note":"behavior passed on final source"}}');
    publicationModule.publishRoomResult = actualPublisher;
    const crashScript = `require('./src/lib/task-graph/execution-progress').applyExecutionOutcomeTx=async()=>process.exit(71); require('./src/lib/task-graph/room-result-publication').publishRoomResult(${JSON.stringify(delivered.turn.id)}).catch(error=>{console.error(error);process.exit(72)});`;
    assert.throws(() => execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', crashScript], {
      cwd: process.cwd(), env: { ...process.env, TS_NODE_BASEURL: '.', TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}' }, stdio: 'pipe',
    }), (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 71);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'room_result_published' } }), 0);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).commit, null);
    const callsBeforeRecovery = calls;
    await recoverRoomResults();
    assert.equal(calls, callsBeforeRecovery, 'Restart publishes saved evidence without another model turn');
    const published = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'room_result_published' } });
    const rejected = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'room_result_rejected' } });
    assert.equal(published.length, 1, JSON.stringify(rejected.map(event => event.payload)));
    const accepted = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(accepted.status, 'integrated');
    assert.equal(executionProgress(accepted.dispatchMetadata)?.platformAttempts, 7);
    assert.equal(executionProgress(accepted.dispatchMetadata)?.repairAttempts, 3);
    await Promise.all([publishRoomResult(delivered.turn.id), publishRoomResult(delivered.turn.id)]);
    for (let i = 0; i < 8; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } })).status, 'passed');
    const successor = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: 'B' } } });
    assert.ok(successor.childTaskId);
    assert.equal(await prisma.taskRun.count({ where: { taskId: successor.childTaskId } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, nodeId: successor.nodeId, kind: 'node_ready' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'room_result_published' } }), 1);
    commitRoom = false;
    const handover = await prisma.task.create({ data: { name: 'registered handover', workingDirectory: repository } });
    const handoverRoom = await prisma.liveRoom.create({ data: { title: 'handover', sourceTaskId: handover.id } });
    fixtureRooms.push(handoverRoom.id);
    const source = await prisma.liveRoomMessage.create({ data: { roomId: handoverRoom.id, messageType: 'user', content: 'fixture' } });
    await prisma.workflowDispatch.create({ data: { projectId: 'fixture', jobId: 'watcher', eventKey: source.id, roomId: handoverRoom.id, messageId: source.id, state: 'reply_queued' } });
    const planReceipt = await prisma.liveRoomMessage.create({ data: { roomId: handoverRoom.id, messageType: 'system',
      content: 'Handoff PLAN committed', metadata: JSON.stringify({ systemEvent: 'handoff_plan_committed' }) } });
    await prisma.workflowDispatch.create({ data: { projectId: handover.id, jobId: 'live_room_handoff_plan', eventKey: planReceipt.id,
      roomId: handoverRoom.id, messageId: planReceipt.id, state: 'reply_queued' } });
    assert.deepEqual(await resolveCompletionOwner(handover.id), { kind: 'handover', projectId: 'fixture', jobId: 'watcher' });
    output = '普通完成';
    await prisma.liveRoomMember.createMany({ data: [
      { roomId: handoverRoom.id, memberType: 'user', displayName: 'user' },
      { roomId: handoverRoom.id, memberType: 'local_agent', displayName: 'codex', harnessType: 'codex', backend: 'platform_local',
        runtimeAgentId: 'codex', role: 'implementer', canReply: true },
    ] });
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: handoverRoom.id, appId: 'fixture', chatId: 'handover-fixture',
      scopeKey: 'feishu:p2p:handover-fixture', chatType: 'p2p' } });
    const handoverCalls = calls;
    const handoverInput = { context: { appId: 'fixture', chatId: 'handover-fixture', chatType: 'p2p', senderOpenId: 'fixture-user',
      messageId: 'handover-with-plan-history' }, content: '查看当前状态' };
    await Promise.all([postFeishuMessageToBoundLiveRoom(handoverInput), postFeishuMessageToBoundLiveRoom(handoverInput)]);
    await until(async () => await prisma.liveRoomDelivery.count({ where: { roomMessage: { roomId: handoverRoom.id }, deliveryStatus: 'delivered' } }) === 1);
    const handoverTurn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: handover.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(handoverTurn.status, 'completed'); assert.equal(calls, handoverCalls + 1);
    assert.equal(await recordTaskRunResult(handoverTurn.id), null); assert.deepEqual(wakeups, [handover.id]);
    assert.equal(await prisma.liveRoomMessage.count({ where: { roomId: handoverRoom.id, messageType: 'assistant', content: output } }), 1);
    const conflictingWatcher = await prisma.workflowDispatch.create({ data: { projectId: 'fixture', jobId: 'other-watcher', eventKey: source.id,
      roomId: handoverRoom.id, messageId: source.id, state: 'completed' } });
    await assert.rejects(resolveCompletionOwner(handover.id), /conflicting registered workflow owners/);
    await prisma.workflowDispatch.delete({ where: { id: conflictingWatcher.id } });
    const ordinary = await prisma.task.create({ data: { name: 'task-graph-fake', workingDirectory: repository } });
    const ordinaryRoom = await prisma.liveRoom.create({ data: { title: 'ordinary with control history', sourceTaskId: ordinary.id } });
    fixtureRooms.push(ordinaryRoom.id);
    const ordinaryReceipt = await prisma.liveRoomMessage.create({ data: { roomId: ordinaryRoom.id, messageType: 'system', content: 'control receipt' } });
    await prisma.workflowDispatch.createMany({ data: [
      { projectId: ordinary.id, jobId: 'live_room_handoff_plan', eventKey: ordinaryReceipt.id, roomId: ordinaryRoom.id, messageId: ordinaryReceipt.id, state: 'reply_queued' },
      { projectId: 'fixture', jobId: 'counter', eventKey: ordinaryReceipt.id, roomId: ordinaryRoom.id, messageId: ordinaryReceipt.id, state: 'completed' },
    ] });
    assert.deepEqual(await resolveCompletionOwner(ordinary.id), { kind: 'conversation' });
    await executeAcpxTaskRun({ taskId: ordinary.id, taskName: ordinary.name, workingDirectory: repository, participants: [participant], orchestrationMode: 'single' });
    assert.deepEqual(wakeups, [handover.id]);
    output = 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"automatic delivery","evidence":["artifact.txt"]}';
    const automaticParent = await prisma.task.create({ data: { name: 'automatic formal result' } });
    fixtureParents.push(automaticParent.id);
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
    // A real scheduled reviewer first answers conversationally; replying to its card publishes the next verdict.
    const reviewRepository = path.join(root, 'review-aux');
    git(root, 'clone', repository, reviewRepository);
    const reviewParent = await prisma.task.create({ data: { name: 'room reviewer publication' } });
    fixtureParents.push(reviewParent.id);
    const reviewGraph = await createTaskGraphRun({ parentTaskId: reviewParent.id, version: 1, requestKey: reviewParent.id, definition: {
      deliveryContract: 'agent_owned_v1', specRef: 'test://room-review', nodes: ['R', 'S'].map(key => ({ key, goal: key, dependsOn: key === 'S' ? ['R'] : [], executionMode: key === 'R' ? 'lean' : 'implement',
        acceptance: key === 'R' ? { mode: 'agent', checks: ['behavior'], reviewerId: 'local:codex', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } } : { mode: 'automatic', checks: ['behavior'] },
        executions: [repository, reviewRepository].map((repo, index) => ({ key: `repo-${index}`, repository: repo, gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] } })) })) } });
    reviewOutput = '先说明验收方式，本轮没有正式结论。';
    for (let i = 0; i < 4; i++) { await runTaskGraphCycle(); await drain(); }
    const reviewJob = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: reviewGraph.id, key: 'R' } } });
    const reviewTaskId = `task-graph-review-${reviewJob.nodeId}`;
    const reviewTurn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: reviewTaskId }, orderBy: { createdAt: 'desc' } });
    assert.equal(await prisma.taskRun.count({ where: { taskId: reviewTaskId } }), 1, 'An ordinary reviewer reply must not start a result recollection');
    const reviewRoom = await prisma.liveRoom.create({ data: { title: 'review room', sourceTaskId: reviewJob.childTaskId } });
    fixtureRooms.push(reviewRoom.id);
    const reviewMembers = await ensureGraphRoomParticipants(reviewRoom.id, reviewJob.id);
    await prisma.liveRoom.update({ where: { id: reviewRoom.id }, data: { currentSpeakerMemberId: reviewMembers.find(member => member.role === 'implementer')!.id } });
    const reviewBinding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: reviewRoom.id, appId: 'fixture', chatId: 'review-results', scopeKey: reviewRoom.id, chatType: 'group', threadId: 'review-thread', rootMessageId: 'review-root' } });
    await prisma.taskRunFeishuRelay.create({ data: { taskRunId: reviewTurn.id, bindingId: reviewBinding.id, messageId: 'review-card' } });
    let reviewIndex = 0;
    const reviewIngress = async (response: string) => {
      reviewOutput = response;
      const before = calls;
      const messageId = `review-response-${++reviewIndex}`;
      await postFeishuMessageToBoundLiveRoom({ context: { appId: 'fixture', chatId: 'review-results', chatType: 'group', threadId: 'review-thread', senderOpenId: 'fixture-user', messageId, parentMessageId: reviewIndex === 1 ? 'review-card' : 'review-root' }, content: '继续验收并报告真实结论' });
      await until(async () => calls === before + 1 && await prisma.liveRoomDelivery.count({ where: { roomMessage: { roomId: reviewRoom.id, metadata: { contains: messageId } }, deliveryStatus: 'delivered' } }) > 0);
      return prisma.taskRun.findFirstOrThrow({ where: { taskId: reviewTaskId }, orderBy: { createdAt: 'desc' } });
    };
    await prisma.taskGraphExecution.update({ where: { id: reviewJob.id }, data: { commit: 'b'.repeat(40) } });
    const stale = await reviewIngress('TASK_GRAPH_REVIEW {"approved":true,"note":"Old card must not approve a new candidate"}');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: reviewGraph.id, idempotencyKey: `room-result-published:${stale.id}` } }), 0);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: reviewGraph.id, idempotencyKey: `room-result-rejected:${stale.id}` } }), 1);
    await prisma.taskGraphExecution.update({ where: { id: reviewJob.id }, data: { commit: reviewJob.commit } });
    const exhaustedReview = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reviewJob.id } });
    await prisma.taskGraphExecution.update({ where: { id: reviewJob.id }, data: { status: 'attention', dispatchMetadata: metadataWithProgress(exhaustedReview.dispatchMetadata, {
      ...executionProgress(exhaustedReview.dispatchMetadata)!, state: 'exhausted', platformAttempts: 9,
    }) } });
    await prisma.taskGraphNode.update({ where: { id: reviewJob.nodeId }, data: { status: 'attention' } });
    const failed = await reviewIngress('TASK_GRAPH_REVIEW {"approved":false,"failureKind":"blocked_require_human","note":"Missing acceptance material"}');
    const reviewErrors = await prisma.taskGraphEvent.findMany({ where: { nodeId: reviewJob.nodeId, kind: 'room_result_rejected' } });
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: reviewJob.nodeId } })).status, 'attention', JSON.stringify(reviewErrors));
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: reviewGraph.id, node: { key: 'S' }, kind: 'node_ready' } }), 0);
    const passed = await reviewIngress('TASK_GRAPH_REVIEW {"approved":true,"note":"Behavior checked on the fixed candidate"}');
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: reviewJob.nodeId } })).status, 'passed', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: reviewJob.nodeId, kind: 'room_result_rejected' } })));
    await Promise.all([publishRoomResult(passed.id), publishRoomResult(passed.id)]);
    for (let i = 0; i < 4; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: reviewGraph.id, node: { key: 'S' }, kind: 'node_ready' } }), 1);
    const reviewSuccessor = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: reviewGraph.id, key: 'S' } } });
    assert.equal(await prisma.taskRun.count({ where: { taskId: reviewSuccessor.childTaskId! } }), 1, JSON.stringify(await prisma.taskGraphExecution.findMany({ where: { nodeId: reviewSuccessor.nodeId } })));
    console.log('Room review: multi-repository inputs, stale card rejection, exhausted continuation, failed/approved publication, successor once passed');
    assert.notEqual(passed.id, failed.id);
    assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reviewJob.id } })).dispatchMetadata)?.platformAttempts, 9);
    reviewOutput = null;
    output = '普通回答，等待下一条工作指令';
    const humanParent = await prisma.task.create({ data: { name: 'room human gate' } });
    fixtureParents.push(humanParent.id);
    const humanGraph = await createTaskGraphRun({ parentTaskId: humanParent.id, version: 1, requestKey: humanParent.id, definition: {
      deliveryContract: 'agent_owned_v1', specRef: 'test://room-human', nodes: ['H', 'I'].map(key => ({ key, goal: key, dependsOn: key === 'I' ? ['H'] : [], executionMode: key === 'H' ? 'lean' : 'implement',
        acceptance: key === 'H' ? { mode: 'human', checks: ['behavior'], reviewerId: 'fixture-human' } : { mode: 'automatic', checks: ['behavior'] },
        executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] } }] })) } });
    await runTaskGraphCycle(); await drain();
    const humanJob = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: humanGraph.id, key: 'H' } } });
    const humanRoom = await prisma.liveRoom.create({ data: { title: 'human gate', sourceTaskId: humanJob.childTaskId } });
    fixtureRooms.push(humanRoom.id);
    await ensureGraphRoomParticipants(humanRoom.id, humanJob.id);
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: humanRoom.id, appId: 'fixture', chatId: 'human-results', scopeKey: humanRoom.id, chatType: 'group', threadId: 'human-thread', rootMessageId: 'human-root' } });
    commitRoom = true;
    output = 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"self-tested source","evidence":["H.txt"],"ticketVerification":{"approved":true,"note":"self test passed"}}';
    await postFeishuMessageToBoundLiveRoom({ context: { appId: 'fixture', chatId: 'human-results', chatType: 'group', threadId: 'human-thread', senderOpenId: 'fixture-user', messageId: 'human-result', parentMessageId: 'human-root' }, content: '完成实施并自测交付' });
    await until(async () => await prisma.taskGraphEvent.count({ where: { nodeId: humanJob.nodeId, kind: 'room_result_published' } }) === 1);
    notices.sendGraphHumanReviewCard = async () => {};
    for (let i = 0; i < 3; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: humanJob.nodeId } })).status, 'awaiting_human');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: humanGraph.id, node: { key: 'I' }, kind: 'node_ready' } }), 0);
    await approveHumanNode({ runId: humanGraph.id, nodeKey: 'H', reviewerId: 'fixture-human', approved: true, note: 'approve tested candidate' });
    for (let i = 0; i < 4; i++) { await runTaskGraphCycle(); await drain(); }
    const humanSuccessor = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: humanGraph.id, key: 'I' } } });
    assert.equal(await prisma.taskRun.count({ where: { taskId: humanSuccessor.childTaskId! } }), 1);
    commitRoom = false;
    console.log('Room self-test preserves the configured human gate; only its actual approval releases the successor');
    const conflict = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'conflicting registration' } });
    await prisma.workflowDispatch.create({ data: { projectId: 'fixture', jobId: 'watcher', eventKey: conflict.id, roomId: room.id, messageId: conflict.id, state: 'reply_queued' } });
    await assert.rejects(resolveCompletionOwner(job.childTaskId), /conflicting registered workflow owners/);
    console.log('Actual automatic and Feishu room entry: shared durable result intake, duplicate callback, immutable receipt, no ordinary commit/recollection, exclusive graph/handover routing and automatic C -> D delivery passed. Room A -> B self-verification, final committed source, concurrent duplicate publication and exhausted history preservation passed.');
  } finally { await drain(); adapter.execute = original.execute; adapter.resume = original.resume;
    await prisma.liveRoom.deleteMany({ where: { id: { in: fixtureRooms } } });
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: { in: fixtureParents } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
