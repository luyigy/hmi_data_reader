import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { claimExecution, createTaskGraphRun } from '../src/lib/task-graph/store';
import { ensureGraphRoomParticipants } from '../src/lib/task-graph/conversation-members';
import { executeLiveRoomReplyViaAcpx } from '../src/lib/live-room-delivery-execution';
import { getHarnessAdapter } from '../src/lib/harness';
import { buildAcpxPermissionConfigForProfile } from '../src/lib/acpx/permissions';
import { initialExecutionProgress, executionProgress } from '../src/lib/task-graph/execution-progress';

import { graphRoomTarget } from '../src/lib/task-graph/room-context';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import { createGraphWriter, releaseTaskRunWriter, observeTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { legacyWriterFingerprint, hasLegacyWriterRelease } from '../src/lib/task-graph/legacy-writer-release';
import os from 'node:os';
import { exitedGraphWriter } from './fixtures/exited-graph-writer';
import { registerGraphReviewWorker, releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { triggerLiveRoomMessageReplies } from '../src/lib/live-room-delivery';
import { postFeishuMessageToBoundLiveRoom } from '../src/lib/feishu-live-room';
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out awaiting fixture boundary');
}
export async function normalRoomEntryRegression(options: { slowWriter?: boolean } = {}) {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const writerModule = require('../src/lib/task-graph/writer-ownership');
  const savedObserve = writerModule.observeTaskRunWriter;
  let delayOnce = options.slowWriter;
  writerModule.observeTaskRunWriter = async (...args: unknown[]) => {
    if (delayOnce) { delayOnce = false; await new Promise(resolve => setTimeout(resolve, 5200)); }
    return savedObserve(...args);
  };
  const root = mkdtempSync(path.join(tmpdir(), 'thin-room-'));
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  require('../src/lib/live-room-progress').attachLiveRoomProgress = async () => ({ streamCallbacks: {}, dispose: async () => {} });
  require('../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async () => { throw new Error('Graph chat must not wake handover watcher'); };
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [] });
  require('../src/lib/feishu-live-room-relay').relayLiveRoomMessageToFeishu = async () => {};
  const adapter = getHarnessAdapter('codex')!;
  const saved = { execute: adapter.execute, resume: adapter.resume };
  const calls: Array<{ task: string; session?: string; directory?: string; mode?: string }> = [];
  let expireNative = false;
  let failNative = false;
  let hold: (() => Promise<void>) | undefined;
  adapter.execute = async args => {
    calls.push({ task: args.task.id, directory: args.context.workingDirectory, mode: args.context.permissionConfig?.sandboxMode });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    if (hold) await hold();
    if (failNative) throw new Error('permanent-native-failure');
    return { success: true, output: '普通聊天回复，没有正式交付。', sessionId: `native-${args.task.id}`, sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.resume = async args => { if (expireNative) { expireNative = false; return { success: false, output: '', error: 'thread not found', executionTime: 1 }; } const result = await adapter.execute(args); calls[calls.length - 1].session = args.sessionId; return result; };
  const fixtureTasks: string[] = [], fixtureRooms: string[] = [], fixtureGraphs: string[] = [];
  try {
    for (const project of ['alpha', 'beta']) {
      const directory = path.join(root, project);
      execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
      git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost'); git('commit', '--allow-empty', '-m', 'base');
      const auxiliary = path.join(root, project + '-aux');
      execFileSync('git', ['clone', directory, auxiliary], { stdio: 'pipe' });
      const parent = await prisma.task.create({ data: { name: project } });
      fixtureTasks.push(parent.id);
      // A route's parent conversation is not a graph execution, even with an overlapping directory.
      // Both pre-scope Writer metadata and current ordinary runs must stay outside graph admission.
      await prisma.taskRun.createMany({ data: [
        { taskId: parent.id, status: 'completed', controlMetadata: JSON.stringify({ workingDirectory: directory, graphWriter: {} }) },
        { taskId: parent.id, status: 'running', controlMetadata: JSON.stringify({ workingDirectory: directory }) },
      ] });
      const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', agentId: 'codex', role: 'implementer' };
      const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
        specRef: 'test://thin-room', nodes: [{ key: 'T', goal: project, dependsOn: [], acceptance: { mode: 'agent', checks: ['fixture'], reviewerId: 'local:codex', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } },
          executions: [{ key: 'repo', repository: directory, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant } }, { key: 'aux', repository: auxiliary, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'auxiliary', launchConfig: { participant } }] }] } });
      fixtureGraphs.push(graph.id);
      const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id }, key: 'repo' } });
      const permission = buildAcpxPermissionConfigForProfile('dev_local', [directory]);
      const child = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: project, workingDirectory: directory, acpxPermissionConfig: JSON.stringify(permission) } });
      fixtureTasks.push(child.id);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: directory, dispatchMetadata: { progress: initialExecutionProgress() } } });
      const room = await prisma.liveRoom.create({ data: { title: project, sourceTaskId: child.id } });
      fixtureRooms.push(room.id);
      const members = await ensureGraphRoomParticipants(room.id, job.id);
      const target = members.find(m => m.role === 'implementer')!;
      const memberSession = await prisma.liveRoomMemberSession.create({ data: { roomId: room.id, memberId: target.id, status: 'active', backend: 'platform_local', sessionKey: room.id } });
      const legacy = await prisma.taskRun.create({ data: { taskId: child.id, status: 'completed', completedAt: new Date(),
        controlMetadata: '{}', participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local',
          harnessType: 'codex', role: 'implementer', status: 'completed', completedAt: new Date() } } }, include: { participants: true } });
      const legacyRequest = { taskId: child.id, taskName: child.name, workingDirectory: directory,
        permissionConfig: permission, participants: [participant], orchestrationMode: 'single' as const };
      await executeAcpxTaskRun(legacyRequest); // Unrelated terminal history is not a current owner.
      const legacyRelease = { version: 1, kind: 'service_drain', hostname: os.hostname(), uid: process.getuid?.(),
        taskRunId: legacy.id, identitySha256: legacyWriterFingerprint(legacy), releasedAt: new Date().toISOString(), evidenceSha256: 'a'.repeat(64) };
      const releasedLegacy = await prisma.taskRun.update({ where: { id: legacy.id },
        data: { controlMetadata: JSON.stringify({ legacyWriterRelease: legacyRelease }) }, include: { participants: true } });
      assert.equal(hasLegacyWriterRelease(releasedLegacy), true);
      assert.equal((await observeTaskRunWriter(legacy.id)).kind, 'exited');
      assert.equal(hasLegacyWriterRelease({ ...releasedLegacy, controlMetadata: '{invalid' }), false);
      assert.equal(hasLegacyWriterRelease({ ...releasedLegacy, status: 'running' }), false);
      assert.equal(hasLegacyWriterRelease({ ...releasedLegacy, controlMetadata: JSON.stringify({ legacyWriterRelease: { ...legacyRelease, hostname: 'other-host' } }) }), false);
      assert.equal(hasLegacyWriterRelease({ ...releasedLegacy, controlMetadata: JSON.stringify({ legacyWriterRelease: legacyRelease, graphWriter: {} }) }), false);
      assert.equal(hasLegacyWriterRelease({ ...releasedLegacy, participants: releasedLegacy.participants.map(p => ({ ...p, controlMetadata: '{"changed":true}' })) }), false);
      const historicalWriter = await exitedGraphWriter();
      const trackedHistory = { ...legacy, controlMetadata: JSON.stringify({ graphWriter: historicalWriter }) };
      const trackedRelease = { ...legacyRelease, identitySha256: legacyWriterFingerprint(trackedHistory) };
      const trackedMetadata = { graphWriter: historicalWriter, legacyWriterRelease: trackedRelease };
      assert.equal(hasLegacyWriterRelease({ ...trackedHistory, controlMetadata: JSON.stringify(trackedMetadata) }), true);
      assert.equal(hasLegacyWriterRelease({ ...trackedHistory, controlMetadata: JSON.stringify({ ...trackedMetadata,
        graphWriter: { ...historicalWriter, nonce: 'changed' } }) }), false, 'A drain receipt cannot release a changed Writer');
      await prisma.taskRun.update({ where: { id: legacy.id }, data: { controlMetadata: JSON.stringify(trackedMetadata) } });
      const projectStart = calls.length;
      for (const [phase, state, status] of [['implement', 'active', 'claimed'], ['acceptance', 'active', 'verifying'], ['acceptance', 'exhausted', 'attention'], ['acceptance', 'ready', 'passed']]) {
        await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status } });
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention', dispatchMetadata: { progress: { ...initialExecutionProgress(), phase, state } } } });
        const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: `继续 ${project} ${state}` } });
        const loaded = await prisma.liveRoom.findUniqueOrThrow({ where: { id: room.id }, include: { members: { include: { gateway: true, agentRecord: true } } } });
        const before = calls.length;
        await executeLiveRoomReplyViaAcpx({ room: loaded, sourceMessage: message, targetMember: loaded.members.find(m => m.id === target.id)!, session: memberSession });
        assert.equal(calls.length, before + 1, `Normal entry must execute ${project}/${phase}/${state}`);
        assert.equal(target.acpxPermissionConfig, null, 'New graph members inherit actual task permission');
        assert.equal(calls.at(-1)?.mode, 'workspace-write');
        assert.equal(calls.at(-1)?.task, child.id);
        assert.equal(calls.at(-1)?.directory, directory);
        if (before > projectStart) assert.equal(calls.at(-1)?.session, `native-${child.id}`);
      }
      assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 0);
      // A failed ordinary turn never revives graph retry budgets or mutates the saved candidate.
      const graphBeforeFailure = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      const failedMessage = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '继续核对' } });
      const failureRoom = await prisma.liveRoom.findUniqueOrThrow({ where: { id: room.id }, include: { members: { include: { gateway: true, agentRecord: true } } } });
      failNative = true;
      const beforeFailure = calls.length;
      try {
        await assert.rejects(executeLiveRoomReplyViaAcpx({ room: failureRoom, sourceMessage: failedMessage, targetMember: failureRoom.members.find(m => m.id === target.id)!, session: memberSession }), /permanent-native-failure/);
      } finally { failNative = false; }
      assert.equal(calls.length, beforeFailure + 1, 'Permanent failure does not open an autonomous retry loop');
      assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), graphBeforeFailure, 'Ordinary failure retains candidate, claim, revision, evidence and budgets');

      // Replying to an older review card preserves that participant and its directory.
      const reviewer = members.find(m => m.role === 'tester')!;
      const reviewDirectory = path.join(root, project + '-review'); mkdirSync(reviewDirectory);
      const review = await prisma.task.create({ data: { id: `task-graph-review-${job.nodeId}`, name: 'review', workingDirectory: reviewDirectory,
        acpxPermissionConfig: JSON.stringify(buildAcpxPermissionConfigForProfile('dev_local', [reviewDirectory])) } });
      fixtureTasks.push(review.id);
      const reviewSession = await prisma.taskSession.create({ data: { taskId: review.id } });
      const writer = await createGraphWriter();
      const candidates = (await prisma.taskGraphExecution.findMany({ where: { nodeId: job.nodeId } })).map(item => ({ id: item.id, commit: git('rev-parse', 'HEAD') }));
      const reviewRun = await prisma.taskRun.create({ data: { taskId: review.id, taskSessionId: reviewSession.id, mode: 'acpx', status: 'completed',
        controlMetadata: JSON.stringify({ graphWriter: writer, workingDirectory: reviewDirectory, graphReview: { runId: graph.id, nodeId: job.nodeId, phase: 'acceptance', claimKey: 'historical' }, reviewCandidates: candidates }),
        participants: { create: { ...participant, role: 'tester', runner: 'codex', gatewayNameSnapshot: 'local', controlMetadata: JSON.stringify({ lastSessionId: `old-review-${project}`, lastSessionKind: 'codex_thread' }) } } } });
      await releaseTaskRunWriter(reviewRun.id, writer.nonce);
      await prisma.taskRunEvent.create({ data: { taskRunId: reviewRun.id, sequence: 1, eventType: 'runner_started', content: 'fixture', metadata: JSON.stringify({ workingDirectory: reviewDirectory, extraReadOnlyPaths: [directory, auxiliary] }) } });
      const binding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, appId: 'fixture', chatId: project, scopeKey: room.id, chatType: 'group', threadId: 'thread-' + project, rootMessageId: 'root' } });
      await prisma.taskRunFeishuRelay.create({ data: { taskRunId: reviewRun.id, bindingId: binding.id, messageId: 'old-card' } });
      const reply = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '继续原验收会话', metadata: JSON.stringify({ feishuParentMessageId: 'old-card', feishuBindingId: binding.id }) } });
      const destination = await graphRoomTarget(room.id, reply.id, target.id);
      assert.equal(destination?.memberId, reviewer.id, 'Card binding takes priority over selected implementer');
      await prisma.liveRoom.update({ where: { id: room.id }, data: { currentSpeakerMemberId: target.id } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'acceptance', state: 'exhausted', platformAttempts: 15 } } } });
      const implicit = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '继续验收', metadata: JSON.stringify({ feishuParentMessageId: 'root', feishuBindingId: binding.id, mentionedMemberIds: [], targetLocked: false }) } });
      const implicitTarget = await graphRoomTarget(room.id, implicit.id);
      assert.equal(implicitTarget?.memberId, reviewer.id, 'Acceptance defaults to tester even when current speaker is implementer');
      assert.equal(implicitTarget?.target.kind === 'session' && implicitTarget.target.taskSessionId, reviewSession.id);
      const loaded = await prisma.liveRoom.findUniqueOrThrow({ where: { id: room.id }, include: { members: { include: { gateway: true, agentRecord: true } } } });
      const call = (message: typeof reply, memberId = reviewer.id) => executeLiveRoomReplyViaAcpx({ room: loaded, sourceMessage: message, targetMember: loaded.members.find(m => m.id === memberId)!, session: memberSession });
      await call(reply);
      assert.equal(calls.at(-1)?.task, review.id); assert.equal(calls.at(-1)?.session, `old-review-${project}`);
      assert.equal(calls.at(-1)?.directory, reviewDirectory); assert.equal(calls.at(-1)?.mode, 'workspace-write');
      const resumedReview = await prisma.taskRun.findFirstOrThrow({ where: { taskId: review.id }, orderBy: { createdAt: 'desc' } });
      assert.equal(resumedReview.taskSessionId, reviewSession.id);
      assert.deepEqual(JSON.parse(resumedReview.controlMetadata!).reviewCandidates, candidates);
      assert.deepEqual(JSON.parse(resumedReview.controlMetadata!).graphResultBinding.inputs, candidates.map(item => ({ executionId: item.id, commit: item.commit })).sort((a, b) => a.executionId.localeCompare(b.executionId)), 'Result intake preserves every historical review candidate instead of relabeling it with current execution commits');

      // A failed first launch has a platform Session and workspace, but no native thread yet.
      const noNative = await prisma.taskRun.create({ data: { taskId: review.id, taskSessionId: reviewSession.id, mode: 'acpx', status: 'failed',
        controlMetadata: reviewRun.controlMetadata, participants: { create: { ...participant, role: 'tester', runner: 'codex', gatewayNameSnapshot: 'local', controlMetadata: '{}' } } } });
      await releaseTaskRunWriter(noNative.id, writer.nonce);
      await prisma.taskRunEvent.create({ data: { taskRunId: noNative.id, sequence: 1, eventType: 'runner_started', content: 'failed before native creation', metadata: JSON.stringify({ workingDirectory: reviewDirectory, extraReadOnlyPaths: [directory, auxiliary] }) } });
      const noNativeMessage = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '重试尚未启动的验收会话' } });
      const noNativeTarget = await graphRoomTarget(room.id, noNativeMessage.id);
      assert.equal(noNativeTarget?.target.kind === 'session' && noNativeTarget.target.taskRunId, noNative.id);
      await call(noNativeMessage);
      const freshNative = await prisma.taskRun.findFirstOrThrow({ where: { taskId: review.id }, orderBy: { createdAt: 'desc' } });
      assert.equal(freshNative.status, 'completed');
      assert.equal(freshNative.taskSessionId, reviewSession.id, 'Native creation preserves the original platform Session');
      assert.equal(calls.at(-1)?.session, undefined);
      assert.equal(calls.at(-1)?.directory, reviewDirectory);
      assert.deepEqual(JSON.parse(freshNative.controlMetadata!).reviewCandidates, candidates);
      assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.platformAttempts, 15);

      // Explicit new-session rotation remains per role, including replies to old cards.
      await prisma.taskSession.create({ data: { taskId: child.id, metadata: JSON.stringify({ source: 'feishu_new_session', rotationCheckpoint: 'completed', targetMemberIds: [reviewer.id] }) } });
      const fresh = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '新会话继续', metadata: reply.metadata } });
      await call(fresh);
      assert.equal(calls.at(-1)?.task, review.id); assert.equal(calls.at(-1)?.session, undefined);

      expireNative = true;
      const expired = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '失效会话继续', metadata: reply.metadata } });
      await call(expired);
      assert.equal(expireNative, false, 'Attempted the captured native session before fresh fallback');
      assert.equal(calls.at(-1)?.session, undefined);
      const afterExpiry = await prisma.taskRun.findFirstOrThrow({ where: { taskId: review.id }, orderBy: { createdAt: 'desc' } });
      assert.equal(JSON.parse(afterExpiry.controlMetadata!).freshRetry.used, true);
      const readOnly = JSON.stringify({ ...permission, profile: 'custom', sandboxMode: 'read-only', writableRoots: [reviewDirectory] });
      await prisma.liveRoomMember.update({ where: { id: reviewer.id }, data: { acpxPermissionConfig: readOnly } });
      loaded.members.find(member => member.id === reviewer.id)!.acpxPermissionConfig = readOnly;
      const explicitRead = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '显式只读', metadata: reply.metadata } });
      await call(explicitRead); assert.equal(calls.at(-1)?.mode, 'read-only', 'Explicit user permission remains authoritative');

      // A completed database status alone cannot establish that a writer exited.
      const liveWriter = await createGraphWriter();
      const latest = await prisma.taskRun.findFirstOrThrow({ where: { taskId: child.id }, orderBy: { createdAt: 'desc' } });
      const beforeMetadata = JSON.parse(latest.controlMetadata!);
      await prisma.taskRun.update({ where: { id: latest.id }, data: { controlMetadata: JSON.stringify({ ...beforeMetadata, graphWriter: liveWriter, graphWriterReleased: undefined }) } });
      await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'claimed', claimToken: 'race-node' } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'ready', claimToken: null, taskRunId: latest.id, dispatchMetadata: { progress: initialExecutionProgress() } } });
      assert.equal(await claimExecution(graph.id, 'T', 'repo', 'blocked-auto', prisma, await createGraphWriter()), null);
      await releaseTaskRunWriter(latest.id, liveWriter.nonce);
      const request = { taskId: child.id, taskName: child.name, workingDirectory: directory, permissionConfig: permission, participants: [participant], orchestrationMode: 'single' as const };
      const sessions = await Promise.all([1, 2].map(() => prisma.taskSession.create({ data: { taskId: child.id } })));
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; }); hold = () => barrier;
      const count = calls.length;
      const first = executeAcpxTaskRun({ ...request, taskSessionId: sessions[0].id });
      await until(() => calls.length === count + 1);
      const second = executeAcpxTaskRun({ ...request, taskSessionId: sessions[1].id });
      assert.equal(await claimExecution(graph.id, 'T', 'repo', 'concurrent-auto', prisma, await createGraphWriter()), null);
      await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'verifying' } });
      await prisma.taskGraphExecution.updateMany({ where: { nodeId: job.nodeId }, data: { status: 'integrated', commit: git('rev-parse', 'HEAD') } });
      assert.equal(await registerGraphReviewWorker(graph.id, 'T'), null, 'Automatic review also defers to the chat writer');
      await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'claimed' } });
      await prisma.taskGraphExecution.updateMany({ where: { nodeId: job.nodeId }, data: { status: 'ready' } });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(calls.length, count + 1, 'Different sessions sharing a directory cannot launch two writers');
      hold = undefined; release();
      await Promise.all([first, second]); assert.equal(calls.length, count + 2);

      // The reverse race: an automatic claim occupies the same boundary before harness startup.
      const automatic = await claimExecution(graph.id, 'T', 'repo', 'auto-first', prisma, await createGraphWriter());
      assert.ok(automatic);
      const deferredCount = calls.length;
      const deferred = executeAcpxTaskRun({ ...request, taskSessionId: sessions[1].id });
      await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(calls.length, deferredCount);
      const progress = (automatic.dispatchMetadata as any).progress;
      await releaseGraphExecutionWorker(job.id, 'auto-first', progress.worker.nonce);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention' } });
      await deferred; assert.equal(calls.length, deferredCount + 1);
      const unknown = await prisma.taskRun.findFirstOrThrow({ where: { taskId: child.id }, orderBy: { createdAt: 'desc' } });
      const savedMetadata = unknown.controlMetadata!;
      const unknownMetadata = JSON.parse(savedMetadata);
      unknownMetadata.graphWriter.hostname = 'unobservable-host';
      delete unknownMetadata.graphWriterReleased;
      await prisma.taskRun.update({ where: { id: unknown.id }, data: { controlMetadata: JSON.stringify(unknownMetadata) } });
      const currentTracked = await prisma.taskRun.findFirstOrThrow({ where: { taskId: child.id, controlMetadata: { contains: '"graphWriter"' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      assert.equal(currentTracked.id, unknown.id, 'Unknown fixture must refer to the latest tracked owner');
      assert.equal((await observeTaskRunWriter(unknown.id)).kind, 'unknown');
      await assert.rejects(executeAcpxTaskRun({ ...request, taskSessionId: sessions[1].id }), /writer .*unknown/);
      await prisma.taskRun.update({ where: { id: unknown.id }, data: { controlMetadata: savedMetadata } });

      // Actual Feishu ingress uses the ordinary delivery queue, once per message.
      require('../src/lib/feishu-turn-card').prepareRoomTurnCard = async () => null;
      const inbound = { context: { appId: 'fixture', chatId: project, chatType: 'group', threadId: 'thread-' + project,
        senderOpenId: 'fixture-user', messageId: 'inbound-' + project, parentMessageId: 'root' }, content: '继续任务' };
      const ingressCount = calls.length;
      await Promise.all([postFeishuMessageToBoundLiveRoom(inbound), postFeishuMessageToBoundLiveRoom(inbound)]);
      await until(() => calls.length === ingressCount + 1);
      await until(async () => await prisma.liveRoomDelivery.count({ where: { roomMessage: { roomId: room.id }, deliveryStatus: 'delivered' } }) > 0);
      assert.equal(await prisma.liveRoomMessage.count({ where: { roomId: room.id, metadata: { contains: '\"feishuMessageId\":\"inbound-' + project + '\"' } } }), 1);
      assert.equal(calls.length, ingressCount + 1);
      console.log(`${project}: card/native identity, new session, completed-but-live writer, cross-session mutex, automatic claim defer passed`);
      console.log(`${project}: implement/acceptance/exhausted/completed use normal writable runtime`);
    }
  } finally { writerModule.observeTaskRunWriter = savedObserve; adapter.execute = saved.execute; adapter.resume = saved.resume; await prisma.liveRoom.deleteMany({ where: { id: { in: fixtureRooms } } }); await prisma.taskGraphRun.deleteMany({ where: { id: { in: fixtureGraphs } } }); await prisma.task.deleteMany({ where: { id: { in: fixtureTasks } } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) normalRoomEntryRegression().catch(error => { console.error(error); process.exitCode = 1; });
