import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { relayTaskGraphReplies, relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';

async function main() {
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api');
  const cards = require('../src/lib/feishu-task-entry-api');
  const original = { send: api.sendFeishuInteractiveMessage, update: cards.updateFeishuTaskEntryCard, reply: api.replyFeishuMessage };
  const sent: { threadRootMessageId: string; card: unknown }[] = [];
  const updated: { id: string; card: unknown }[] = [];
  const replies: { messageId: string; uuid: string; content: Record<string, unknown>; msgType: string; replyInThread: boolean }[] = [];
  api.replyFeishuMessage = async (args: typeof replies[number]) => { replies.push(args); return `progress-${replies.length}`; };
  let rejectUpdate = false;
  api.sendFeishuInteractiveMessage = async (args: { threadRootMessageId: string; card: unknown }) => { sent.push(args); return `reply-${sent.length}`; };
  cards.updateFeishuTaskEntryCard = async (id: string, card: unknown) => { if (rejectUpdate) throw new Error('update failed'); updated.push({ id, card }); };
  const task = await prisma.task.create({ data: { id: `task-graph-relay-${randomUUID()}`, name: 'S03 · mold' } });
  const room = await prisma.liveRoom.create({ data: { title: task.name, sourceTaskId: task.id } });
  try {
    await prisma.feishuConversationBinding.create({ data: { scopeKey: task.id, liveRoomId: room.id,
      appId: 'test', chatId: 'science-chat', chatType: 'group', rootMessageId: 'child-root', threadId: 'child-thread' } });
    const run = await prisma.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'running', participants: {
      create: { gatewayNameSnapshot: 'Platform Local', runner: 'codex', harnessType: 'codex', harnessNameSnapshot: 'Codex', role: 'implementer', status: 'running' } }, events: { create: [
      { sequence: 1, eventType: 'runner_started', content: '运行开始' },
      { sequence: 2, eventType: 'stdout_chunk', stream: 'stdout', content: '正在实现 S03。' },
      { sequence: 3, eventType: 'control_message', content: '工具：读取规格 OPENAI_API_KEY=secretvalue' },
    ] } } });
    assert.equal(await relayTaskGraphRunReply(run.id), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].threadRootMessageId, 'child-root');
    const json = JSON.stringify(sent[0].card);
    assert.match(json, /实施者.*Codex/); assert.match(json, /正在实现 S03/); assert.match(json, /运行开始/);
    const progress = sent[0].card as { body: { elements: { tag: string; expanded?: boolean; header?: { title: { content: string } }; elements?: unknown[] }[] } };
    const panels = progress.body.elements.filter(element => element.tag === 'collapsible_panel');
    assert.equal(panels.length, 3);
    panels.shift();
    assert.equal(panels[0].expanded, false); assert.equal(panels[1].expanded, false);
    assert.match(panels[0].header?.title.content || '', /系统信息/);
    assert.match(panels[1].header?.title.content || '', /工具调用/);
    assert.doesNotMatch(JSON.stringify(panels[0]), /工具：读取规格/);
    assert.match(JSON.stringify(panels[1]), /读取规格/);
    assert.doesNotMatch(json, /secretvalue/);
    assert.equal(await relayTaskGraphRunReply(run.id), false);
    assert.equal(sent.length, 1, 'History replay must not resend an existing card');
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 4, eventType: 'stdout_chunk', content: '正在检查' } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Do not publish unfinished paragraphs');
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 5, eventType: 'stdout_chunk', content: '保存读回。\n\n' } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Progress must update the same card, not create paragraph cards');
    assert.equal(updated.at(-1)?.id, 'reply-1');
    assert.match(JSON.stringify(updated.at(-1)?.card), /正在实现 S03。正在检查保存读回/);
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Repeated polls must not duplicate progress');
    updated.length = 0;
    await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'waiting_for_input' } });
    const request = await prisma.taskRunInteractionRequest.create({ data: { taskId: task.id, taskRunId: run.id,
      requestKind: 'permission_request', message: '暂存 S03 文件', rawPayload: JSON.stringify({ approvalSupported: true }), expiresAt: new Date(Date.now() + 60_000) } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(updated[0].id, 'reply-1');
    assert.match(JSON.stringify(updated[0].card), new RegExp(`approve:${request.id}`));
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 6, eventType: 'control_message', content: '等待权限确认' } });
    rejectUpdate = true;
    await assert.rejects(() => relayTaskGraphRunReply(run.id), /update failed/);
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } })).deliveredSequence, 5);
    rejectUpdate = false;
    await Promise.all([relayTaskGraphRunReply(run.id), relayTaskGraphRunReply(run.id)]);
    assert.equal(updated.length, 2, 'Concurrent relays must update once');
    assert.equal(sent.length, 1);
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: run.id }, data: { status: 'completed', summary: 'S03 已提交，等待验收。' } });
    await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'completed', completedAt: new Date() } });
    await prisma.taskRunInteractionRequest.update({ where: { id: request.id }, data: { status: 'approved' } });
    await relayTaskGraphReplies();
    assert.match(JSON.stringify(updated.at(-1)?.card), /S03 已提交，等待验收/, 'Final reply must remain on the same card');
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } })).lastStatus, 'completed');
    assert.equal(sent.length, 1);
    assert.equal(replies.length, 0, 'Final result must not create another card');
    assert.match(JSON.stringify(updated.at(-1)?.card), /会话结束/);
    assert.doesNotMatch(JSON.stringify(updated.at(-1)?.card), /Slice 已完成/);
    await relayTaskGraphReplies();
    assert.equal(replies.length, 0, 'The final result must not create a new reply');
    const marker = 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"environment_failed","note":"project environment missing"}';
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: run.id }, data: { summary: marker } });
    await relayTaskGraphRunReply(run.id, true);
    assert.match(JSON.stringify(updated.at(-1)?.card), /实施暂停/);
    assert.match(JSON.stringify(updated.at(-1)?.card), /project environment missing/);
    assert.equal(sent.length, 1); assert.equal(replies.length, 0);
    console.log('Feishu progress patches one card, folds details, preserves approvals and exposes blocked delivery');
  } finally {
    api.sendFeishuInteractiveMessage = original.send; cards.updateFeishuTaskEntryCard = original.update; api.replyFeishuMessage = original.reply;
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
