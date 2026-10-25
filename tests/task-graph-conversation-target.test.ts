import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { getHarnessAdapter } from '../src/lib/harness';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { reserveConversationFollowup, startConversationFollowups } from '../src/lib/task-graph/conversation-followup';
import assert from 'node:assert/strict';
import { m06ConversationRegression } from './task-graph-m06-conversation.fixture';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { ensureGraphRoomParticipants } from '../src/lib/task-graph/conversation-members';
import { receiveGraphTaskMessage, conversationInputs, bindConversationInputs, registerConversationSteering, deliverConversationSteering } from '../src/lib/task-graph/conversation-inbox';

import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { conversationContinuation } from '../src/lib/task-graph/conversation-continuation';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const directory = mkdtempSync(path.join(tmpdir(), 'target-conversation-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost'); git('commit', '--allow-empty', '-m', 'base');
  const commit = git('rev-parse', 'HEAD');
  const inputsDirectory = path.join(directory, 'inputs'); mkdirSync(inputsDirectory);
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(directory, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(directory, 'validation');
  const require = createRequire(__filename);
  require('../src/lib/task-graph/feishu').postGraphChildProgress = async () => {};
  const parent = await prisma.task.create({ data: { name: 'target isolation' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', agentId: 'codex', role: 'implementer' };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://target', nodes: [{ key: 'T', goal: 'target isolation', dependsOn: [], acceptance: { mode: 'agent', checks: ['target isolation'], reviewerId: 'local:codex',
      reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } }, executions: [{ key: 'repo', repository: directory, gitRef: 'refs/heads/main', baseCommit: commit,
      agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant } }] }] } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const child = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'implementation' } });
  const review = await prisma.task.create({ data: { id: `task-graph-review-${job.nodeId}`, name: 'review' } });
  const room = await prisma.liveRoom.create({ data: { title: 'same Codex, separate roles', sourceTaskId: child.id } });
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, claimToken: 'fixture-owner', worktreePath: directory, commit: commit } });
  try {
    const members = await ensureGraphRoomParticipants(room.id, job.id);
    assert.equal(members.filter(m => m.memberType === 'local_agent').length, 2, 'Same model must retain separate role identities');
    assert.equal((await ensureGraphRoomParticipants(room.id, job.id)).length, 2, 'Role creation is idempotent');
    const makeRun = async (taskId: string, role: string, native: string) => {
      const session = await prisma.taskSession.create({ data: { taskId } });
      const run = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, controlMetadata: JSON.stringify({ reviewCandidates: [{ id: job.id, commit: commit }] }), mode: 'acpx', status: 'running', participants: { create: {
        role, runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', gatewayId: 'platform-local', gatewayNameSnapshot: 'local', agentId: 'codex',
        controlMetadata: JSON.stringify({ lastSessionId: native, lastSessionKind: 'codex_thread' }) } } }, include: { participants: true } });
      await prisma.taskSession.update({ where: { id: session.id }, data: { activeRunId: run.id } });
      await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 1, eventType: 'runner_started', content: 'start', metadata: JSON.stringify({ workingDirectory: directory, extraReadOnlyPaths: [inputsDirectory] }) } });
      return run;
    };
    const implementer = await makeRun(child.id, 'implementer', 'native-implementation');
    const tester = await makeRun(review.id, 'tester', 'native-review');
    const binding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, appId: 'fixture', chatId: 'target-chat', scopeKey: room.id, chatType: 'group', rootMessageId: 'target-root' } });
    await prisma.taskRunFeishuRelay.create({ data: { taskRunId: tester.id, bindingId: binding.id, messageId: 'review-card' } });
    const message = { taskId: child.id, sourceId: 'quoted-review', actorId: 'fixture', content: '原图在资料表里',
      sourceMetadata: JSON.stringify({ feishuParentMessageId: 'review-card', feishuBindingId: binding.id }) };
    await receiveGraphTaskMessage(message);
    const input = (await conversationInputs(job.id))[0];
    const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: input.id } });
    assert.match(JSON.stringify(event.payload), new RegExp(tester.id));
    assert.match(JSON.stringify(event.payload), /native-review/);
    await prisma.taskRun.update({ where: { id: tester.id }, data: { status: 'completed' } });
    const otherTester = await makeRun(review.id, 'tester', 'native-other-review');
    await receiveGraphTaskMessage(message);
    assert.deepEqual((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: input.id } })).payload, event.payload, 'Retry cannot retarget an already received message');
    await assert.rejects(prisma.$transaction(tx => bindConversationInputs(tx, job.id, [input.id], implementer.id)), /target|会话/i);
    await assert.rejects(prisma.$transaction(tx => bindConversationInputs(tx, job.id, [input.id], otherTester.id)), /target|会话/i);
    const continuation = await conversationContinuation(job.id, input.target);
    assert.equal(continuation.taskId, review.id);
    assert.equal(continuation.taskSessionId, tester.taskSessionId);
    assert.equal(continuation.participant.resumeSessionId, 'native-review');
    assert.equal(continuation.participant.role, 'tester');
    assert.equal(continuation.workingDirectory, directory);
    assert.deepEqual(continuation.extraReadOnlyPaths, [inputsDirectory]);
    const setReviewer = async (id: string) => prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated',
      dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'acceptance', review: { kind: 'running', phase: 'acceptance', taskRunId: id, candidateCommit: commit, claimKey: 'test-review' } } } } });
    await setReviewer(otherTester.id);
    let wrongSends = 0;
    const detachWrong = registerConversationSteering(job.id, otherTester.id, async () => { wrongSends++; return 'accepted'; });
    await deliverConversationSteering();
    assert.equal(wrongSends, 0, 'New reviewer must not receive a queued message for the old reviewer');
    detachWrong();
    await prisma.taskRun.update({ where: { id: tester.id }, data: { status: 'running' } });
    await setReviewer(tester.id);
    let received = '';
    const detach = registerConversationSteering(job.id, tester.id, async (_id, text) => { received += text; return 'accepted'; });
    await deliverConversationSteering(); await deliverConversationSteering(); detach();
    assert.match(received, /原图在资料表里/);
    assert.equal((received.match(/原图在资料表里/g) || []).length, 1, 'Active review steering receives the full input once');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_steering_result', payload: { path: ['result'], equals: 'accepted' } } }), 1);
    await receiveGraphTaskMessage({ ...message, sourceId: 'second-quoted-review' });
    const second = (await conversationInputs(job.id))[0];
    await prisma.taskRunParticipant.update({ where: { id: tester.participants[0].id }, data: { controlMetadata: JSON.stringify({ lastSessionId: 'drifted-native', lastSessionKind: 'codex_thread' }) } });
    await assert.rejects(prisma.$transaction(tx => bindConversationInputs(tx, job.id, [second.id], tester.id)), /native session changed/);
    await assert.rejects(conversationContinuation(job.id, second.target), /原生会话身份/);
    await prisma.taskRunParticipant.update({ where: { id: tester.participants[0].id }, data: { controlMetadata: tester.participants[0].controlMetadata } });
    await prisma.$transaction(tx => bindConversationInputs(tx, job.id, [second.id], tester.id));
    assert.equal((await conversationInputs(job.id)).length, 0);
    await receiveGraphTaskMessage({ ...message, sourceId: 'followup-review', content: '解释刚才的验收结论' });
    const writer = await createGraphWriter();
    for (const run of [implementer, tester]) await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'completed',
      controlMetadata: JSON.stringify({ graphWriter: writer, reviewCandidates: [{ id: job.id, commit: commit }] }) } });
    await releaseTaskRunWriter(implementer.id, writer.nonce);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: implementer.id } });
    assert.equal(await reserveConversationFollowup(job.nodeId), null, 'An unreleased review writer blocks followup even after its status becomes completed');
    await releaseTaskRunWriter(tester.id, writer.nonce);
    const adapter = getHarnessAdapter('codex')!;
    const saved = { execute: adapter.execute, resume: adapter.resume };
    let turns = 0;
    adapter.execute = async () => { throw new Error('Must resume original reviewer'); };
    adapter.resume = async args => {
      turns++;
      assert.equal(args.sessionId, 'native-review');
      assert.equal(args.task.id, review.id);
      assert.equal(args.context.workingDirectory, directory);
      assert.equal(args.context.permissionConfig?.sandboxMode, 'read-only');
      assert.match(args.continuationMessage, /解释刚才的验收结论/);
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
      args.context.onSpawn?.(child); await once(child, 'exit');
      const detach = args.context.streamCallbacks?.onSteeringReady?.(async (_id, text) => { assert.match(text, /补充一个问题/); return 'accepted'; });
      await receiveGraphTaskMessage({ ...message, sourceId: 'followup-steering', content: '补充一个问题' });
      await deliverConversationSteering(); detach?.();
      return { success: true, output: '这是原验收结论的解释。', sessionId: 'native-review', sessionKind: 'codex_thread', executionTime: 1 };
    };
    try {
      const work = await startConversationFollowups(1);
      assert.equal(work.length, 1);
      await Promise.all(work.map(item => item.promise));
      assert.equal(turns, 1, JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { runId: graph.id, kind: 'conversation_followup_deferred' }, select: { payload: true } })));
      assert.equal((await conversationInputs(job.id)).length, 0, 'Followup and its steering are consumed in the original reviewer session');
      const last = await prisma.taskRun.findFirstOrThrow({ where: { taskId: review.id }, orderBy: { createdAt: 'desc' }, include: { participants: true } });
      assert.equal(last.status, 'completed');
      assert.equal(last.taskSessionId, tester.taskSessionId);
      assert.equal(last.participants[0].role, 'tester');
      assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_deferred' } }), 0);
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(current.status, 'integrated'); assert.equal(current.commit, commit);
      assert.doesNotMatch(JSON.stringify(current.dispatchMetadata), new RegExp('conversationOwnerRunId[^,]*' + last.id));
      assert.equal((await startConversationFollowups(1)).length, 0, 'No fresh input means no repeat dispatch');
    } finally { adapter.execute = saved.execute; adapter.resume = saved.resume; }
    await m06ConversationRegression();
    console.log('Same-model roles are distinct; quoted message stays bound to its original session across queueing and duplicate arrival');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.deleteMany({ where: { id: { in: [child.id, review.id, parent.id] } } });
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
