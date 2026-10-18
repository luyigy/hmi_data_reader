import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareAcceptanceRuntime } from '../src/lib/task-graph/acceptance-runtime';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { postFeishuMessageToBoundLiveRoom } from '../src/lib/feishu-live-room';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { requestGraphConversationRecovery } from '../src/lib/task-graph/conversation-recovery';
import { handleGraphConversationIntent, resumeIntent, applyGraphControlOutput } from '../src/lib/task-graph/conversation-intent';
import { scheduleGraphRepair } from '../src/lib/task-graph/repair';

async function main() {
  const temp = mkdtempSync(path.join(tmpdir(), 'graph-continuation-'));
  const originalValidation = process.env.TASK_GRAPH_VALIDATION_ROOT; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(temp, 'runtime');
  const originalAdmin = process.env.FEISHU_ADMIN_OPEN_ID; process.env.FEISHU_ADMIN_OPEN_ID = 'fixture-admin';
  const require = createRequire(__filename), api = require('../src/lib/feishu-api');
  const entry = require('../src/lib/feishu-task-entry-api');
  const delivery = require('../src/lib/live-room-delivery');
  const originalTrigger = delivery.triggerLiveRoomMessageReplies;
  let discussionCalls = 0; delivery.triggerLiveRoomMessageReplies = async () => { discussionCalls++; };
  const originalGroupAdmin = entry.isFeishuGroupAdmin; entry.isFeishuGroupAdmin = async () => false;
  const originalReply = api.replyFeishuMessage; api.replyFeishuMessage = async () => 'ack';
  const parent = await prisma.task.create({ data: { name: 'continuation' } });
  const child = await prisma.task.create({ data: { name: 'S05 child' } });
  const room = await prisma.liveRoom.create({ data: { title: 'parent', sourceTaskId: parent.id } });
  const childRoom = await prisma.liveRoom.create({ data: { title: 'child', sourceTaskId: child.id } });
  let runId: string | undefined;
  try {
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, scopeKey: parent.id, appId: 'fixture', chatId: 'chat', chatType: 'group', threadId: 'parent-thread' } });
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://continue', nodes: ['S05', 'OTHER'].map(key => ({ key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['roundtrip'] }, executions: [{ key: 'mold', repository: '/tmp/fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } }] })) } });
    runId = run.id;
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'S05' } } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    await prisma.taskGraphExecution.updateMany({ where: { nodeId: node.id }, data: { status: 'integrated', childTaskId: child.id, commit: 'b'.repeat(40) } });
    assert.equal(resumeIntent('用这张不同的图继续验收'), true);
    assert.equal(resumeIntent('不要让Codex继续验收'), false);
    assert.equal(resumeIntent('不要让我再敲命令了，继续验收'), true);
    assert.equal(resumeIntent('为什么卡住了？继续验收'), false);
    const context = { roomId: room.id, chatId: 'chat', openId: 'fixture-admin', messageId: 'message', text: '用这张继续验收' };
    const inbound = { context: { appId: 'fixture', chatId: 'chat', chatType: 'group', senderOpenId: 'fixture-admin', messageId: 'message', threadId: 'parent-thread' }, content: '用这张继续验收' };
    await postFeishuMessageToBoundLiveRoom(inbound);
    await postFeishuMessageToBoundLiveRoom(inbound);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_review_recovery_requested' } }), 1);
    assert.equal(await handleGraphConversationIntent({ ...context, messageId: 'question', text: '为什么还没有验收？' }), false);
    for (const text of ['不要继续验收', '先别跑测试', '不需要恢复验收', '能不能继续验收', '只读打开不启动验收', '[图片消息]']) assert.equal(resumeIntent(text), false);
    await assert.rejects(requestGraphConversationRecovery({ ...context, messageId: 'stranger', openId: 'stranger' }), /管理员/);
    const other = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'OTHER' } } });
    await prisma.taskGraphNode.update({ where: { id: other.id }, data: { status: 'attention' } });
    await assert.rejects(requestGraphConversationRecovery({ ...context, messageId: 'ambiguous' }), /S05.*OTHER|OTHER.*S05/);
    const explicit = await requestGraphConversationRecovery({ ...context, messageId: 'explicit', text: 'S05 继续验收' });
    assert.equal(explicit.nodeId, node.id);
    const control = await applyGraphControlOutput({ roomId: room.id, sourceContent: 'S05 往下走吧', sourceMetadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'chat', feishuMessageId: 'control' }), output: '<graph-control>{"action":"resume_acceptance","nodeKey":"S05"}</graph-control>' });
    assert.doesNotMatch(control, /graph-control/);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_review_recovery_requested' } }), 3);
    assert.equal(await handleGraphConversationIntent({ ...context, messageId: 'select-request', text: '继续验收' }), true);
    assert.equal(await handleGraphConversationIntent({ ...context, messageId: 'select-answer', text: 'S05' }), true);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_recovery_target_resolved' } }), 1);
    await handleGraphConversationIntent({ ...context, messageId: 'cancel-select', text: '继续验收' });
    assert.equal(await handleGraphConversationIntent({ ...context, messageId: 'cancel', text: '不用了' }), false);
    assert.equal(await handleGraphConversationIntent({ ...context, messageId: 'late-selection', text: 'S05' }), false);
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: childRoom.id, scopeKey: child.id, appId: 'fixture', chatId: 'child-chat', chatType: 'group', threadId: 'child-thread' } });
    for (const [index, text] of Array.from(['继续', '@_user_1 你执行啊，那个多维表格里面也有其他品牌的 HMI 界面，正好来做这个验收啊。', 'S05 重新跑一下'].entries())) {
      const childInbound = { context: { ...inbound.context, chatId: 'child-chat', threadId: 'child-thread', messageId: `child-continue-${index}` }, content: text };
      await postFeishuMessageToBoundLiveRoom(childInbound);
      await postFeishuMessageToBoundLiveRoom(childInbound);
      const requested = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: { runId: run.id, idempotencyKey: `conversation:review-recovery:${childInbound.context.messageId}` } } });
      assert.equal(requested.nodeId, node.id, 'Child topic resumes its own Slice even when another Slice is paused');
      assert.equal(requested.kind, 'conversation_review_recovery_requested');
      assert.equal(await prisma.taskGraphEvent.count({ where: { runId, idempotencyKey: requested.idempotencyKey } }), 1);
    }
    const childControl = await applyGraphControlOutput({ roomId: childRoom.id, sourceContent: '@_user_1 你执行啊', sourceMetadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'child-chat', feishuMessageId: 'child-continue-1' }), output: '<graph-control>{"action":"resume_task","nodeKey":"S05"}</graph-control>' });
    assert.match(childControl, /平台已回复/);
    for (const [index, text] of Array.from(['稍后再重跑', '先别执行', '能不能重新跑一下？'].entries())) {
      await applyGraphControlOutput({ roomId: childRoom.id, sourceContent: text, sourceMetadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'child-chat', feishuMessageId: `child-no-authorization-${index}` }), output: '<graph-control>{"action":"resume_task","nodeKey":"S05"}</graph-control>' });
      assert.equal(await prisma.taskGraphEvent.count({ where: { runId, idempotencyKey: `conversation:review-recovery:child-no-authorization-${index}` } }), 0);
    }
    assert.equal(discussionCalls, 0, 'Execution instructions must not launch a readonly discussion');
    for (const text of ['不要重跑', '先别执行', '你执行过了吗？', '现在重跑可以吗', '稍后再重跑', '等我确认后再执行', '继续讨论这个方案', '之前执行失败了', '执行分工是什么意思？']) assert.equal(resumeIntent(text), false, text);
    const evidence = { summary: 'save defect', checks: [{ name: 'roundtrip', passed: false, evidence: 'wrong value after reopen' }] };
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'blocked_require_human', note: 'photo blurred' }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'roundtrip', note: 'wrong save' }, evidence), true);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'claimed');
    const event = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
    assert.ok(JSON.stringify(event.payload).includes('bbbbbbbb'), 'Keep previous delivery/evidence before repair');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } })) {
      const progress = executionProgress(job.dispatchMetadata); assert.ok(progress);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', claimToken: 'completed-repair-' + progress.repairAttempts, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    }
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'roundtrip', note: 'same defect' }, evidence), true);
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } })) {
      const progress = executionProgress(job.dispatchMetadata); assert.ok(progress);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', claimToken: 'completed-repair-' + progress.repairAttempts, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    }
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'roundtrip', note: 'same defect' }, evidence), false);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 2);
    assert.equal((await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } })).issueKind, 'retry_exhausted');
    const code = path.join(temp, 'source.js'); writeFileSync(code, 'source');
    const runtime = await prepareAcceptanceRuntime(node.id, 'test', [{ repository: temp, path: temp, commit: 'a'.repeat(40) }]);
    const command = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', `const f=require('fs'),a=require('assert');f.writeFileSync('test-db.json','{}');a.throws(()=>f.writeFileSync(${JSON.stringify(code)},'bad'));`], cwd: runtime.directory, workspaceRoot: runtime.directory, sandboxMode: runtime.permissionConfig.sandboxMode, env: process.env, readOnlyPaths: [code] });
    execFileSync(command.command, command.args, { env: process.env });
    console.log('Parent/child execution instructions resume the bound Slice idempotently without readonly discussion; questions, negation and future work stay paused');
  } finally {
    delivery.triggerLiveRoomMessageReplies = originalTrigger;
    api.replyFeishuMessage = originalReply; entry.isFeishuGroupAdmin = originalGroupAdmin;
    if (originalAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID; else process.env.FEISHU_ADMIN_OPEN_ID = originalAdmin;
    if (originalValidation === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = originalValidation;
    rmSync(temp, { recursive: true, force: true });
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } });
    await prisma.liveRoom.deleteMany({ where: { id: { in: [room.id, childRoom.id] } } }); await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
