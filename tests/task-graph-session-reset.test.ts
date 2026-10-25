import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerRunningProcess, clearRunningProcess } from '../src/lib/acpx/process-registry';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { interruptLiveRoomMemberReplies } from '../src/lib/live-room-interrupt';
import { waitForGraphRoomMemberStop } from '../src/lib/task-graph/conversation-reset-stop';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { assertGraphConversationRunSession } from '../src/lib/task-graph/conversation-reset';
import { implementationConversation } from '../src/lib/task-graph/conversation-session';
import { conversationContinuation } from '../src/lib/task-graph/conversation-continuation';
import { resolveConversationTarget, assertConversationTargetRun } from '../src/lib/task-graph/conversation-target';
import { receiveGraphTaskMessage, conversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { rotateTaskSession } from '../src/lib/acpx/session';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const live = createRequire(__filename)('../src/lib/live-room-messages');
  const post = live.postLiveRoomMessage;
  live.postLiveRoomMessage = async () => {};
  const parent = await prisma.task.create({ data: { name: 'reset-boundary' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const commit = 'a'.repeat(40);
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://reset', nodes: [{ key: 'A', goal: 'reset', dependsOn: [], executionMode: 'full',
      acceptance: { mode: 'agent', checks: ['fixed candidate'], reviewerId: 'fixture', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } },
      executions: [{ key: 'code', repository: process.cwd(), gitRef: 'refs/heads/main', baseCommit: commit,
        agentSelector: 'local:codex', instructions: 'approved scope', launchConfig: { participant } }] }] } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const child = await prisma.task.create({ data: { name: 'original scope' } });
  const review = await prisma.task.create({ data: { id: `task-graph-review-${job.nodeId}`, name: 'fixed review' } });
  const room = await prisma.liveRoom.create({ data: { sourceTaskId: child.id, title: 'reset-room', members: { create: ['implementer', 'tester'].map(role => ({
    role, backend: 'platform_local', harnessType: 'codex', displayName: role, memberType: 'local_agent', canReply: true, joinStatus: 'joined' })) } }, include: { members: true } });
  const makeRun = async (taskId: string, taskSessionId: string, role: string, native: string | null) => prisma.taskRun.create({ data: {
    taskId, taskSessionId, status: 'completed', controlMetadata: JSON.stringify({ reviewCandidates: [{ id: job.id, commit }] }),
    participants: { create: { ...participant, role, gatewayNameSnapshot: 'Local', status: 'completed',
      controlMetadata: native ? JSON.stringify({ lastSessionId: native, lastSessionKind: 'codex_thread' }) : null } },
    events: { create: { sequence: 1, eventType: 'runner_started', content: 'fixture', metadata: JSON.stringify({ workingDirectory: process.cwd() }) } },
  }, include: { participants: true } });
  const oldSession = await rotateTaskSession(child.id);
  const reviewSession = await rotateTaskSession(review.id);
  const old = await makeRun(child.id, oldSession.id, 'implementer', 'old-native');
  const tester = await makeRun(review.id, reviewSession.id, 'tester', 'review-native');
  const setOwner = async (runId: string) => prisma.taskGraphExecution.update({ where: { id: job.id }, data: {
    childTaskId: child.id, taskRunId: runId, status: 'attention', claimToken: 'original-claim', worktreePath: process.cwd(),
    dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', state: 'waiting_for_user', taskRunId: runId,
      conversationOwnerRunId: runId, candidateCommit: commit, workspaceBase: commit } },
  } });
  const binding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, scopeKey: child.id, appId: 'test', chatId: child.id, chatType: 'group', rootMessageId: 'root' } });
  await prisma.taskRunFeishuRelay.create({ data: { taskRunId: tester.id, bindingId: binding.id, messageId: 'old-review-card', lastStatus: 'completed' } });
  const target = async (source?: string) => resolveConversationTarget(prisma, await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), source);
  const reviewTarget = () => target(JSON.stringify({ feishuParentMessageId: 'old-review-card', feishuBindingId: binding.id }));
  const reset = async (memberId: string | null, key: string, checkpoint = 'completed') => rotateTaskSession(child.id, { metadata: {
    source: 'feishu_new_session', rotationKey: key, targetMemberId: memberId, rotationCheckpoint: checkpoint,
  } });
  try {
    await setOwner(old.id);
    assert.equal((await implementationConversation(job.id, participant)).participant.resumeSessionId, 'old-native');
    await receiveGraphTaskMessage({ taskId: child.id, actorId: 'fixture', sourceId: 'before-reset', content: 'old queued message' });
    const queued = (await conversationInputs(job.id))[0];
    const fresh = await reset(room.members.find(m => m.role === 'implementer')!.id, 'reset-implementation');
    const resolved = await target();
    assert.equal(resolved.kind === 'session' && resolved.taskSessionId, fresh.id, 'Reset must override the previous conversation destination');
    assert.equal((await conversationInputs(job.id)).length, 0, 'Pre-reset queued input is cancelled, not replayed into a new native session');
    await assert.rejects(assertConversationTargetRun(prisma, queued.target, old.id), /reset|重置/i);
    await assert.rejects(assertGraphConversationRunSession(prisma, await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), old.id), /reset|重置/i);
    const session = await implementationConversation(job.id, participant);
    assert.equal(session.taskSessionId, fresh.id); assert.equal(session.participant.resumeSessionId, undefined);
    const continuation = await conversationContinuation(job.id, resolved);
    assert.equal(continuation.taskSessionId, fresh.id); assert.equal(continuation.participant.resumeSessionId, undefined);
    assert.equal((await reviewTarget()).kind === 'session' && (await reviewTarget() as { taskSessionId: string }).taskSessionId, reviewSession.id, 'Single-member reset does not reset the tester');
    const first = await makeRun(child.id, fresh.id, 'implementer', null);
    await assertConversationTargetRun(prisma, resolved, first.id);
    assert.equal((await conversationContinuation(job.id, await target())).participant.resumeSessionId, undefined, 'A first startup without a native ID retries fresh within the same reset boundary');
    await prisma.taskRunParticipant.update({ where: { id: first.participants[0].id }, data: { controlMetadata: JSON.stringify({ lastSessionId: 'fresh-native', lastSessionKind: 'codex_thread' }) } });
    await setOwner(first.id);
    assert.equal((await implementationConversation(job.id, participant)).participant.resumeSessionId, 'fresh-native');
    assert.equal((await target() as { nativeSessionId: string }).nativeSessionId, 'fresh-native');
    const resetReview = await reset(room.members.find(m => m.role === 'tester')!.id, 'reset-review');
    const rt = await reviewTarget();
    assert.equal(rt.kind, 'session'); if (rt.kind !== 'session') throw new Error('review target missing');
    assert.notEqual(rt.taskSessionId, reviewSession.id); assert.notEqual(rt.taskSessionId, resetReview.id);
    assert.equal(rt.taskId, review.id); assert.equal(rt.candidateCommit, commit);
    const rc = await conversationContinuation(job.id, rt);
    assert.equal(rc.participant.resumeSessionId, undefined); assert.equal(rc.participant.role, 'tester');
    assert.equal((await reviewTarget() as { taskSessionId: string }).taskSessionId, rt.taskSessionId, 'Retry reuses the new review session');
    assert.equal((await implementationConversation(job.id, participant)).participant.resumeSessionId, 'fresh-native', 'A later tester reset does not roll back or reset the implementer');
    const duplicate = await Promise.all([reset(null, 'duplicate-reset'), reset(null, 'duplicate-reset')]);
    assert.equal(duplicate[0].id, duplicate[1].id, 'Concurrent retry creates only one platform Session');
    const writer = await createGraphWriter();
    const childProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: 'ignore' });
    await once(childProcess, 'spawn');
    const exited = once(childProcess, 'exit');
    await prisma.taskRun.update({ where: { id: first.id }, data: { status: 'running', controlMetadata: JSON.stringify({ graphWriter: writer, graphWriterReleased: { nonce: writer.nonce, at: new Date().toISOString() } }) } });
    await prisma.taskRunParticipant.update({ where: { id: first.participants[0].id }, data: { status: 'running' } });
    registerRunningProcess({ taskRunId: first.id, participantId: first.participants[0].id, child: childProcess, executionBackend: 'platform_local', harnessType: 'codex' });
    await assert.rejects(waitForGraphRoomMemberStop(child.id, room.members.find(m => m.role === 'implementer')!, [first.id], 0), /退出/);
    const stopped = await interruptLiveRoomMemberReplies({ roomId: room.id, memberId: room.members.find(m => m.role === 'implementer')!.id, controlAction: 'stop_run' });
    assert.equal(stopped.interruptedRunningCount, 1, 'Graph participant is stopped even without a live-room continuation key');
    await exited; clearRunningProcess(first.participants[0].id);
    await waitForGraphRoomMemberStop(child.id, room.members.find(m => m.role === 'implementer')!);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: tester.id } })).status, 'completed');
    const all = await reset(null, 'reset-all');
    assert.equal((await implementationConversation(job.id, participant)).taskSessionId, all.id);
    assert.equal((await implementationConversation(job.id, participant)).participant.resumeSessionId, undefined);
    assert.notEqual((await reviewTarget() as { taskSessionId: string }).taskSessionId, rt.taskSessionId);
    await assert.rejects(assertConversationTargetRun(prisma, resolved, first.id), /reset|重置/i, 'A reset between target resolution and native startup fences the stale target');
    await reset(null, 'reset-in-progress', 'session_created');
    await assert.rejects(implementationConversation(job.id, participant), /reset|重置/i, 'Incomplete rotation cannot fall back to the old native session');
    const retained = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(retained.claimToken, 'original-claim'); assert.equal(retained.worktreePath, process.cwd());
    console.log('PASS reset boundary: targeted/all, queued input, old review card, first fresh launch, subsequent resume, retry, startup race, fixed role/candidate/workspace');
  } finally {
    live.postLiveRoomMessage = post;
    await prisma.taskGraphRun.delete({ where: { id: graph.id } }); await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.deleteMany({ where: { id: { in: [child.id, review.id, parent.id] } } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
