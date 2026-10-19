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
import { handleGraphConversationIntent, applyGraphControlOutput } from '../src/lib/task-graph/conversation-intent';
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
  const replies: { replyInThread?: boolean }[] = [];
  const originalReply = api.replyFeishuMessage; api.replyFeishuMessage = async (args: typeof replies[number]) => { replies.push(args); return 'ack'; };
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
    const statusQuestions = ['但是当前任务我看已经停了呀，都没有继续了呀。\n\n他好像虽然那个验收通过了，但是并没有往下走啊', '卧槽，你这个还是他妈的很神经啊。你那个R05，他说好像说是继续启动了，但他妈实际上根本就没动啊，咋回事？'];
    const context = { roomId: room.id, chatId: 'chat', openId: 'fixture-admin', messageId: 'message', text: '用这张继续验收' };
    const inbound = { context: { appId: 'fixture', chatId: 'chat', chatType: 'group', senderOpenId: 'fixture-admin', messageId: 'message', threadId: 'parent-thread' }, content: '用这张继续验收' };
    await postFeishuMessageToBoundLiveRoom(inbound);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_review_recovery_requested' } }), 0, 'Parent text reaches the model, not a keyword recovery interceptor');
    assert.equal(discussionCalls, 1);
    await assert.rejects(requestGraphConversationRecovery({ ...context, nodeKey: 'S05', messageId: 'stranger', openId: 'stranger' }), /管理员/);
    const controlText = 'S05 往下走吧';
    await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: controlText,
      metadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'chat', feishuMessageId: 'control' }) } });
    const control = await applyGraphControlOutput({ roomId: room.id, sourceContent: controlText,
      sourceMetadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'chat', feishuMessageId: 'control' }),
      output: '<graph-control>{"action":"resume_task","nodeKey":"S05"}</graph-control>' });
    assert.doesNotMatch(control, /graph-control/);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_review_recovery_requested' } }), 1);
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: childRoom.id, scopeKey: child.id, appId: 'fixture', chatId: 'child-chat', chatType: 'group', threadId: 'child-thread' } });
    for (const [index, text] of Array.from([...statusQuestions, '尺寸使用42', '[图片消息]'].entries())) {
      const childInbound = { context: { ...inbound.context, chatId: 'child-chat', threadId: 'child-thread', messageId: `child-input-${index}` }, content: text };
      await postFeishuMessageToBoundLiveRoom(childInbound); await postFeishuMessageToBoundLiveRoom(childInbound);
    }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'conversation_input' } }), 4);
    assert.equal(discussionCalls, 1, 'Child inputs never start a separate discussion writer');
    await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, scopeKey: 'feishu:p2p:dm-chat', appId: 'fixture', chatId: 'dm-chat', chatType: 'p2p' } });
    for (const [index, text] of Array.from(statusQuestions.entries())) await postFeishuMessageToBoundLiveRoom({ context: { ...inbound.context, chatType: 'p2p', chatId: 'dm-chat', threadId: undefined, messageId: `dm-status-${index}` }, content: text });
    assert.equal(discussionCalls, 3, 'Parent status questions are normal chat');
    const dmText = 'S05 继续验收';
    await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: dmText,
      metadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'dm-chat', feishuMessageId: 'dm-authorized' }) } });
    await handleGraphConversationIntent({ ...context, chatId: 'dm-chat', messageId: 'dm-authorized', text: dmText, nodeKey: 'S05' }, true);
    assert.equal(replies.at(-1)?.replyInThread, false);
    const evidence = { summary: 'save defect', checks: [{ name: 'roundtrip', passed: false, evidence: 'wrong value after reopen' }] };
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'blocked_require_human', note: 'photo blurred' }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'acceptance:roundtrip', note: 'wrong save' }, evidence), true);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'claimed');
    const event = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
    assert.ok(JSON.stringify(event.payload).includes('bbbbbbbb'), 'Keep previous delivery/evidence before repair');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } })) {
      const progress = executionProgress(job.dispatchMetadata); assert.ok(progress);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', claimToken: 'completed-repair-' + progress.repairAttempts, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    }
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'acceptance:roundtrip', note: 'same defect' }, evidence), true);
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } })) {
      const progress = executionProgress(job.dispatchMetadata); assert.ok(progress);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', claimToken: 'completed-repair-' + progress.repairAttempts, dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    }
    assert.equal(await scheduleGraphRepair(run.id, 'S05', { failureKind: 'in_scope_defect', failureKey: 'acceptance:roundtrip', note: 'same defect' }, evidence), false);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 2);
    assert.equal((await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } })).issueKind, 'retry_exhausted');
    const code = path.join(temp, 'source.js'); writeFileSync(code, 'source');
    const runtime = await prepareAcceptanceRuntime(node.id, 'test', [{ repository: temp, path: temp, commit: 'a'.repeat(40) }]);
    const command = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', `const f=require('fs'),a=require('assert');f.writeFileSync('test-db.json','{}');a.throws(()=>f.writeFileSync(${JSON.stringify(code)},'bad'));`], cwd: runtime.directory, workspaceRoot: runtime.directory, sandboxMode: runtime.permissionConfig.sandboxMode, env: process.env, readOnlyPaths: [code] });
    execFileSync(command.command, command.args, { env: process.env });
    console.log('Parent chat reaches the model; child messages enter one durable inbox; explicit authenticated actions preserve permissions and bounded repair');
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
