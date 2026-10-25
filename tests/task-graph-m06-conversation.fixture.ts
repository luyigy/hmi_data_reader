import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, executionProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { receiveGraphTaskMessage, reconcileConversationDeliveries } from '../src/lib/task-graph/conversation-inbox';
import { startConversationFollowups } from '../src/lib/task-graph/conversation-followup';
import { relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';
import { requestResourceAccess, decideResourceAccess } from '../src/lib/task-resources/access';
import { getHarnessAdapter } from '../src/lib/harness';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

export async function m06ConversationRegression() {
  const root = mkdtempSync(path.join(tmpdir(), 'm06-conversation-'));
  const cwd = path.join(root, 'repo'), reader = path.join(root, 'Reader');
  mkdirSync(cwd); mkdirSync(reader); writeFileSync(path.join(reader, 'input'), 'fixed input');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost'); git('commit', '--allow-empty', '-m', 'base');
  const commit = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  process.env.FEISHU_ADMIN_OPEN_ID = 'm06-admin';
  const parent = await prisma.task.create({ data: { name: 'M06 conversation' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex' as const, agentId: 'codex', role: 'implementer' };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://m06-conversation', nodes: [{ key: 'M06', goal: 'conversation', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
      executions: [{ key: 'repo', repository: cwd, baseCommit: commit, gitRef: 'refs/heads/main', agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant } }] }] } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'M06' } });
  const session = await prisma.taskSession.create({ data: { taskId: task.id } });
  const writer = await createGraphWriter();
  const original = await prisma.taskRun.create({ data: { taskId: task.id, taskSessionId: session.id, status: 'completed',
    controlMetadata: JSON.stringify({ graphWriter: writer }), participants: { create: { ...participant, gatewayNameSnapshot: 'local', runner: 'codex',
      controlMetadata: JSON.stringify({ lastSessionId: 'native-m06', lastSessionKind: 'codex_thread' }) } },
    events: { create: { sequence: 1, eventType: 'runner_started', content: 'original', metadata: JSON.stringify({ workingDirectory: cwd }) } } } });
  await releaseTaskRunWriter(original.id, writer.nonce);
  const failedStartup = await prisma.taskRun.create({ data: { taskId: task.id, taskSessionId: session.id, status: 'failed',
    controlMetadata: JSON.stringify({ graphWriter: writer }), participants: { create: { ...participant, gatewayNameSnapshot: 'local', runner: 'codex',
      controlMetadata: JSON.stringify({ resumeSessionId: 'native-m06' }) } },
    events: { create: { sequence: 1, eventType: 'runner_started', content: 'startup failed', metadata: JSON.stringify({ workingDirectory: cwd }) } } } });
  await releaseTaskRunWriter(failedStartup.id, writer.nonce);
  const progress = { ...initialExecutionProgress(), phase: 'implement' as const, state: 'waiting_for_user' as const,
    waitingKind: 'question' as const, taskRunId: failedStartup.id, conversationOwnerRunId: failedStartup.id, candidateCommit: commit, workspaceBase: commit,
    lastFailure: { code: 'permission_required', detail: 'Reader writes unavailable', owner: 'user' as const, requiresUserDecision: true } };
  await prisma.taskGraphRun.update({ where: { id: graph.id }, data: { status: 'running' } });
  await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id, taskRunId: failedStartup.id, status: 'attention',
    claimToken: 'm06-owner', worktreePath: cwd, commit, dispatchMetadata: { progress } } });
  const room = await prisma.liveRoom.create({ data: { title: 'M06', sourceTaskId: task.id } });
  const binding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, scopeKey: task.id, appId: 'test', chatId: 'm06-chat', chatType: 'group', rootMessageId: 'm06-root' } });
  const grant = await requestResourceAccess({ launch: { taskId: task.id, taskName: 'M06', taskSessionId: session.id, orchestrationMode: 'single',
    participants: [participant], workingDirectory: cwd, permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [cwd] } },
    requesterOpenId: 'm06-admin', requesterChatId: 'm06-chat', purpose: 'Reader implementation', resources: [{ path: reader, access: 'write' }] });
  assert.equal(grant.kind, 'request'); if (grant.kind !== 'request') throw new Error('fixture grant missing');
  await decideResourceAccess({ id: grant.approval.id, revision: 1, actorOpenId: 'm06-admin', action: 'approve' });
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'), cards = require('../src/lib/feishu-task-entry-api');
  const runtime = require('../src/lib/task-resources/runtime'), preflight = require('../src/lib/task-graph/runtime-continuity');
  const boundary = require('../src/lib/task-resources/writer-boundary');
  const notices = require('../src/lib/task-graph/feishu');
  const continuation = require('../src/lib/task-graph/conversation-continuation');
  const originalContinuation = continuation.conversationContinuation;
  const adapter = getHarnessAdapter('codex')!;
  const saved = { send: api.sendFeishuInteractiveMessage, update: cards.updateFeishuTaskEntryCard, resources: runtime.resourcesForRun,
    prepare: preflight.prepareTaskDeclaredRuntime, writers: boundary.reserveResourceWriters, notice: notices.postGraphChildProgress, execute: adapter.execute, resume: adapter.resume };
  const sent: string[] = [], sentCards: unknown[] = [], updates: { id: string; card: unknown }[] = [];
  let attempts = 0, modelTurns = 0, extraNotices = 0;
  notices.postGraphChildProgress = async () => { extraNotices++; };
  api.sendFeishuInteractiveMessage = async (args: { card: unknown }) => { sentCards.push(args.card); const id = `m06-card-${sent.length + 1}`; sent.push(id); return id; };
  cards.updateFeishuTaskEntryCard = async (id: string, card: unknown) => { updates.push({ id, card }); };
  boundary.reserveResourceWriters = async () => { throw new Error('Conversation must not reserve Reader writer'); };
  preflight.prepareTaskDeclaredRuntime = async () => { throw new Error('Business preflight unavailable'); };
  runtime.resourcesForRun = async (...args: Parameters<typeof saved.resources>) => {
    const access = await saved.resources(...args);
    assert.deepEqual(access.write, []); assert(access.read.includes(reader));
    attempts++;
    if (attempts <= 3) throw new Error('Injected native startup unavailable');
    return access;
  };
  adapter.execute = async () => { throw new Error('Must retain original native session'); };
  adapter.resume = async args => {
    modelTurns++;
    assert.equal(args.sessionId, 'native-m06'); assert.equal(args.context.permissionConfig?.sandboxMode, 'read-only');
    assert(args.context.extraReadOnlyPaths?.includes(reader)); assert(!args.context.extraWritableRoots?.includes(reader));
    const probe = `const fs=require('fs'),a=require('assert/strict');a.equal(fs.readFileSync(${JSON.stringify(path.join(reader, 'input'))},'utf8'),'fixed input');a.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(reader, 'input'))},'bad'));a.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(cwd, 'bad'))},'bad'));`;
    const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', probe], cwd, workspaceRoot: cwd,
      writableRoots: args.context.extraWritableRoots, readOnlyPaths: args.context.extraReadOnlyPaths, sandboxMode: 'read-only', networkAccess: 'restricted', env: { ...process.env, ...args.context.taskEnvironment } });
    const command = renderBubblewrap(plan), child = spawn(command.command, command.args, { cwd, env: plan.env, stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    args.context.onSpawn?.(child); const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
    return { success: true, output: `原会话解释 ${modelTurns}`, sessionId: 'native-m06', sessionKind: 'codex_thread', executionTime: 1 };
  };
  try {
    await receiveGraphTaskMessage({ taskId: task.id, sourceId: 'question-1', actorId: 'm06-admin', content: '为什么失败？' });
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention');
    const runIds: string[] = [];
    for (let n = 0; n < 4; n++) {
      const work = await startConversationFollowups(1);
      assert.equal(work.length, 1, `Attempt ${n + 1} must start a conversation despite the business write hold`);
      await Promise.all(work.map(item => item.promise));
      const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      assert.notEqual(turn.id, original.id); runIds.push(turn.id);
      assert.equal(turn.taskSessionId, session.id);
      await relayTaskGraphRunReply(turn.id);
      assert.equal(sent.length, 1, 'Three startup failures and the answer must reuse one card');
      if (n < 3) assert.match(JSON.stringify(updates.at(-1)?.card || sentCards[0]), /启动前失败/);
      await reconcileConversationDeliveries();
      await prisma.taskGraphEvent.updateMany({ where: { runId: graph.id, kind: 'conversation_followup_reserved' }, data: { createdAt: new Date(Date.now() - 20_000) } });
    }
    assert.equal(modelTurns, 1); assert.equal(attempts, 4); assert.equal(extraNotices, 0, 'Bound startup failures must not create a separate progress card');
    assert.match(JSON.stringify(updates.at(-1)?.card), /原会话解释 1/);
    const cursors = await prisma.taskRunFeishuRelay.findMany({ where: { taskRunId: { in: runIds } } });
    assert.deepEqual(new Set(cursors.map(row => row.messageId)), new Set(['m06-card-1']));
    await receiveGraphTaskMessage({ taskId: task.id, sourceId: 'question-2', actorId: 'm06-admin', content: '再解释一下，不要恢复实施' });
    const work = await startConversationFollowups(1); assert.equal(work.length, 1); await Promise.all(work.map(item => item.promise));
    const last = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    await relayTaskGraphRunReply(last.id); assert.equal(sent.length, 2, JSON.stringify({ last, sent, attempts, modelTurns, deferred: await prisma.taskGraphEvent.findMany({ where: { runId: graph.id, kind: 'conversation_followup_deferred' }, select: { payload: true } }) })); assert.equal(modelTurns, 2);
    const beforeLate = updates.length;
    await relayTaskGraphRunReply(runIds[0], true);
    assert.equal(updates.length, beforeLate, 'Late failure must not overwrite the successful retry or the next round');
    let preparationAttempts = 0;
    continuation.conversationContinuation = async (...args: Parameters<typeof originalContinuation>) => {
      if (++preparationAttempts <= 3) throw new Error('Injected failure before TaskRun creation');
      return originalContinuation(...args);
    };
    await receiveGraphTaskMessage({ taskId: task.id, sourceId: 'pre-run', actorId: 'm06-admin', content: '启动前失败后仍应在原卡回答' });
    const runCount = await prisma.taskRun.count({ where: { taskId: task.id } });
    for (let attempt = 0; attempt < 4; attempt++) {
      const work = await startConversationFollowups(1); assert.equal(work.length, 1); await work[0].promise;
      if (attempt < 3) assert.equal(await prisma.taskRun.count({ where: { taskId: task.id } }), runCount);
      else {
        const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        await relayTaskGraphRunReply(turn.id);
        assert.equal(updates.at(-1)?.id, 'm06-card-3'); assert.match(JSON.stringify(updates.at(-1)?.card), /原会话解释 3/);
      }
      assert.equal(sent.length, 3, 'Pre-TaskRun failures and eventual answer share exactly one source card');
      await prisma.taskGraphEvent.updateMany({ where: { runId: graph.id, kind: 'conversation_followup_reserved' }, data: { createdAt: new Date(Date.now() - 20_000) } });
    }
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(current.status, 'attention'); assert.equal(current.commit, commit); assert.equal(current.taskRunId, failedStartup.id);
    assert.deepEqual(executionProgress(current.dispatchMetadata)?.lastFailure, progress.lastFailure);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: { in: ['execution_conditions_ready', 'implementation_recovery_scheduled', 'verification_passed'] } } }), 0);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } })).status, 'attention');
    assert.equal((await prisma.feishuAdminApproval.findUniqueOrThrow({ where: { id: grant.approval.id } })).status, 'approved');
    console.log('PASS M06: original session, read-only approved Reader, no business preflight/writer claim, three startup retries share one card, next question gets a new card, frozen business state');
  } finally {
    continuation.conversationContinuation = originalContinuation;
    api.sendFeishuInteractiveMessage = saved.send; cards.updateFeishuTaskEntryCard = saved.update;
    runtime.resourcesForRun = saved.resources; preflight.prepareTaskDeclaredRuntime = saved.prepare; boundary.reserveResourceWriters = saved.writers;
    adapter.execute = saved.execute; adapter.resume = saved.resume; notices.postGraphChildProgress = saved.notice;
    await prisma.feishuAdminApproval.delete({ where: { id: grant.approval.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } }); await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.deleteMany({ where: { id: { in: [task.id, parent.id] } } }); rmSync(root, { recursive: true, force: true });
  }
}
