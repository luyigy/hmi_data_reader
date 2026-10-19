import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestGraphConversationRecovery, startConversationRecoveries } from '../src/lib/task-graph/conversation-recovery';
import { recoverTaskGraphNodeVerification } from '../src/lib/task-graph/coordinator';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { ensureGraphChildTopic } from '../src/lib/task-graph/feishu';
import { prepareGraphConversationTask } from '../src/lib/task-graph/conversation-task';
import { getHarnessAdapter } from '../src/lib/harness';
import { postFeishuMessageToBoundLiveRoom, getBoundLiveRoom } from '../src/lib/feishu-live-room';
import { syncLiveRoomSourceTask } from '../src/lib/live-room-members';
import { getTargetMemberIdsForMessage } from '../src/lib/live-room-delivery-routing';

async function main() {
  const uid = randomUUID();
  const workspace = mkdtempSync(path.join(tmpdir(), 'graph-conversation-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'conversation'); git('add', '.'); git('commit', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const originalAdmin = process.env.FEISHU_ADMIN_OPEN_ID; process.env.FEISHU_ADMIN_OPEN_ID = 'fixture-admin';
  const fixtureRuntime = mkdtempSync(path.join(tmpdir(), 'graph-conversation-runtime-'));
  const originalRuntimeRoot = process.env.TASK_GRAPH_RUNTIME_ROOT; process.env.TASK_GRAPH_RUNTIME_ROOT = fixtureRuntime;
  const oldValidation = process.env.TASK_GRAPH_VALIDATION_ROOT; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(fixtureRuntime, 'validation');
  let recoverySawSupplement = false;
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api');
  const entry = require('../src/lib/feishu-task-entry-api');
  const adapter = getHarnessAdapter('kimi-code'); assert.ok(adapter);
  const originalExecute = adapter.execute;
  const original = { send: api.sendFeishuInteractiveMessage, thread: entry.getFeishuTaskThread, update: entry.updateFeishuTaskEntryCard };
  api.sendFeishuInteractiveMessage = async () => 'root-' + uid;
  entry.getFeishuTaskThread = async () => 'thread-' + uid;
  entry.updateFeishuTaskEntryCard = async () => {};
  const originalToken = api.getFeishuTenantAccessToken;
  api.getFeishuTenantAccessToken = async () => 'test-token';
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture-token', expire: 3600, data: { message_id: 'fixture-message' } }), { status: 200 });
  adapter.execute = async ({ task, context }) => {
    assert.equal(context.permissionConfig?.sandboxMode, task.id.startsWith('task-graph-review-') ? 'workspace-write' : 'read-only');
    assert.match(task.description || '', /Answer questions in the child topic/);
    if (task.id.startsWith('task-graph-review-')) {
      assert.match(task.description || '', /补充材料 SOURCE-42/, 'Recovery must use the new material from the original topic');
      recoverySawSupplement = true;
      return { success: true, output: 'TASK_GRAPH_REVIEW {"approved":false,"note":"测试输入仍不足，保持暂停"}', executionTime: 1 };
    }
    return { success: true, output: '请提供第二张不同的真实照片；当前仍在等待材料。', executionTime: 1 };
  };
  const scope = { appId: 'app-' + uid, chatId: 'chat-' + uid };
  const parent = await prisma.task.create({ data: { name: uid } });
  const child = await prisma.task.create({ data: { name: 'slice-child', description: 'Frozen approved implementation instructions', workingDirectory: workspace } });
  const parentRoom = await prisma.liveRoom.create({ data: { title: uid, sourceTaskId: parent.id } });
  let runId: string | undefined;
  let childRoomId: string | undefined;
  try {
    await prisma.feishuConversationBinding.create({ data: { ...scope, scopeKey: uid, chatType: 'group', liveRoomId: parentRoom.id } });
    await prisma.feishuGroupTaskSettings.create({ data: { ...scope, isolationEnabled: true } });
    const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: uid, definition: { specRef: 'test://conversation', nodes: [{
      key: 'W1', goal: 'Answer questions in the child topic', dependsOn: [], acceptance: { mode: 'agent', reviewerId: 'kimi-code', checks: ['conversation'],
        reviewLaunchConfig: { participant: { ...participant, harnessType: 'kimi-code', role: 'tester' } } }, executions: [{
        key: 'repo', repository: workspace, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] },
      }] }] } });
    runId = run.id;
    const execution = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId } } });
    await prisma.taskGraphExecution.update({ where: { id: execution.id }, data: { childTaskId: child.id, worktreePath: workspace } });
    const args = { parentTaskId: parent.id, executionId: execution.id, childTaskId: child.id, title: child.name, workingDirectory: workspace };
    const binding = await ensureGraphChildTopic(args); assert.ok(binding); childRoomId = binding.liveRoomId;
    const room = await getBoundLiveRoom({ ...scope, chatType: 'group', senderOpenId: 'user', messageId: 'message-' + uid, threadId: 'thread-' + uid }); assert.ok(room);
    const replyable = room.members.filter((member) => member.canReply);
    assert.deepEqual(replyable.map((member) => member.harnessType).sort(), ['codex', 'kimi-code'], 'The child topic must contain its approved implementation and acceptance agents');
    await Promise.all([ensureGraphChildTopic(args), ensureGraphChildTopic(args)]);
    const stable = await getBoundLiveRoom({ ...scope, chatType: 'group', senderOpenId: 'user', messageId: 'message-' + uid, threadId: 'thread-' + uid }); assert.ok(stable);
    assert.equal(stable.members.filter((member) => member.canReply).length, 2, 'Retries must not duplicate members');
    const tester = stable.members.find((member) => member.harnessType === 'kimi-code'); assert.ok(tester);
    const targets = getTargetMemberIdsForMessage({ room: stable, sourceContent: '$kimi-code 要用哪张照片？', sourceMetadata: { primaryTargetMemberId: tester.id } });
    assert.deepEqual(targets, [tester.id], 'Questions can be routed to the named acceptance agent');
    const task = await syncLiveRoomSourceTask(room.id); assert.ok(task);
    assert.equal(task.description, 'Frozen approved implementation instructions', 'A question must not replace the frozen execution instructions');
    await assert.rejects(prepareGraphConversationTask(task), /execution inbox/, 'Child chat cannot create a separate discussion TaskRun');
    await postFeishuMessageToBoundLiveRoom({ context: { ...scope, chatType: 'group', senderOpenId: 'user', messageId: 'real-question-' + uid, threadId: 'thread-' + uid }, content: '$kimi-code 要用哪张照片？' });
    const input = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId, kind: 'conversation_input' } });
    assert.match(JSON.stringify(input.payload), /kimi-code.*要用哪张照片/);
    assert.equal(await prisma.taskRun.count({ where: { taskId: { startsWith: 'task-graph-discussion-' } } }), 0);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).description, 'Frozen approved implementation instructions');
    const request = { roomId: room.id, chatId: scope.chatId, openId: 'fixture-admin', messageId: 'resume-' + uid };
    await assert.rejects(requestGraphConversationRecovery(request), /实施或集成仍未完成/);
    await prisma.taskGraphExecution.update({ where: { id: execution.id }, data: { status: 'integrated', commit: head,
      evidence: { checks: [{ name: 'conversation', passed: true, evidence: 'fixture' }] } } });
    await prisma.taskGraphNode.update({ where: { id: execution.nodeId }, data: { status: 'attention' } });
    await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '补充材料 SOURCE-42' } });
    const requested = await requestGraphConversationRecovery(request);
    assert.equal((await requestGraphConversationRecovery(request)).id, requested.id, 'The same inbound request must be idempotent');
    await assert.rejects(requestGraphConversationRecovery({ ...request, openId: 'stranger', chatId: 'foreign-chat' }), /管理员/);
    const recoveries = await startConversationRecoveries(recoverTaskGraphNodeVerification);
    await Promise.all(recoveries.map((item) => item.promise));
    assert.ok(recoverySawSupplement, 'Coordinator must rerun the actual acceptance flow with the supplied material');
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: execution.nodeId } })).status, 'attention', 'New material alone must not fabricate an acceptance pass');
    assert.equal((await startConversationRecoveries(recoverTaskGraphNodeVerification)).length, 0, 'A consumed request must not start a second review');
    console.log('Graph child topics expose approved members, retain identity and route questions without mutating execution instructions');
  } finally {
    // Keep HTTP stubbed until this isolated test process exits: Feishu relays drain asynchronously.
    adapter.execute = originalExecute; api.getFeishuTenantAccessToken = originalToken;
    api.sendFeishuInteractiveMessage = original.send; entry.getFeishuTaskThread = original.thread; entry.updateFeishuTaskEntryCard = original.update;
    if (childRoomId) await prisma.liveRoom.delete({ where: { id: childRoomId } });
    await prisma.feishuTaskBindingRequest.deleteMany({ where: scope });
    await prisma.feishuGroupTaskSettings.deleteMany({ where: scope });
    await prisma.liveRoom.delete({ where: { id: parentRoom.id } });
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    if (originalAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID; else process.env.FEISHU_ADMIN_OPEN_ID = originalAdmin;
    await prisma.task.deleteMany({ where: { id: { in: runId ? await prisma.task.findMany({ where: { description: { contains: runId } }, select: { id: true } }).then((tasks) => tasks.map((task) => task.id)) : [] } } });
    if (originalRuntimeRoot === undefined) delete process.env.TASK_GRAPH_RUNTIME_ROOT; else process.env.TASK_GRAPH_RUNTIME_ROOT = originalRuntimeRoot;
    if (oldValidation === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = oldValidation;
    await prisma.$disconnect(); rmSync(workspace, { recursive: true, force: true }); rmSync(fixtureRuntime, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
