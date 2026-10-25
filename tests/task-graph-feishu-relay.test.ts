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
    const run = await prisma.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'running', startedAt: new Date(), participants: {
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
    assert.equal(panels[0].expanded, false); assert.equal(panels[1].expanded, false);
    assert.match(panels[0].header?.title.content || '', /思考过程/);
    assert.match(panels[1].header?.title.content || '', /工具调用/);
    assert.doesNotMatch(JSON.stringify(panels[0]), /工具：读取规格/);
    assert.match(JSON.stringify(panels[1]), /读取规格/);
    assert.doesNotMatch(json, /secretvalue/);
    assert.equal(await relayTaskGraphRunReply(run.id), false);
    assert.equal(sent.length, 1, 'History replay must not resend an existing card');
    const sizeParticipant = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: run.id } });
    const observedAt = Date.now();
    await prisma.taskRunFeishuRelay.update({ where: { taskRunId: run.id }, data: { updatedAt: new Date(observedAt - 1000) } });
    await prisma.taskRunParticipant.update({ where: { id: sizeParticipant.id }, data: { controlMetadata: JSON.stringify({
      lastSessionId: 'size-session', runtimeExecution: { id: 'size-execution', participantId: sizeParticipant.id, startedAt: run.startedAt!.getTime() },
      sessionSize: { executionId: 'size-execution', sessionId: 'size-session', totalBytes: 21 * 1024 ** 2, deltaBytes: 1024 ** 2, observedAt },
    }) } });
    assert.equal(await relayTaskGraphRunReply(run.id), true, 'A size warning refreshes the original card even without output events');
    assert.equal(updated.at(-1)?.id, 'reply-1');
    assert.match(JSON.stringify(updated.at(-1)?.card), /21.00 MiB.*本轮新增：\+1.00 MiB/);
    assert.match(JSON.stringify(updated.at(-1)?.card), /强提醒/);
    assert.equal(await relayTaskGraphRunReply(run.id), false, 'The same size sample is not repeatedly delivered');
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 4, eventType: 'stdout_chunk', content: '正在检查' } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Do not publish unfinished paragraphs');
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 5, eventType: 'stdout_chunk', content: '保存读回。\n\n' } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Progress must update the same card, not create paragraph cards');
    assert.equal(updated.at(-1)?.id, 'reply-1');
    assert.match(JSON.stringify(updated.at(-1)?.card), /正在实现 S03。\\n\\n正在检查保存读回/);
    await relayTaskGraphRunReply(run.id);
    assert.equal(replies.length, 0, 'Repeated polls must not duplicate progress');
    updated.length = 0;
    await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'waiting_for_input' } });
    const request = await prisma.taskRunInteractionRequest.create({ data: { taskId: task.id, taskRunId: run.id,
      requestKind: 'permission_request', message: '暂存 S03 文件', rawPayload: JSON.stringify({ approvalSupported: true }), expiresAt: new Date(Date.now() + 60_000) } });
    await relayTaskGraphRunReply(run.id);
    assert.equal(updated[0].id, 'reply-1');
    assert.match(JSON.stringify(updated[0].card), new RegExp(`approve:${request.id}`));
    assert.match(JSON.stringify(updated[0].card), new RegExp(`deny:${request.id}`));
    const question = await prisma.taskRunInteractionRequest.create({ data: { taskId: task.id, taskRunId: run.id,
      requestKind: 'input_request', message: '请选择需要核对的控制器型号' } });
    await relayTaskGraphRunReply(run.id, true);
    assert.match(JSON.stringify((updated.at(-1)?.card as { body: { elements: { tag: string }[] } }).body.elements.filter(e => e.tag === 'markdown')), /请选择需要核对的控制器型号/);
    await prisma.taskRunInteractionRequest.update({ where: { id: question.id }, data: { status: 'answered' } });
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 6, eventType: 'control_message', content: '等待权限确认' } });
    rejectUpdate = true;
    await assert.rejects(() => relayTaskGraphRunReply(run.id), /update failed/);
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } })).deliveredSequence, 5);
    rejectUpdate = false;
    await Promise.all([relayTaskGraphRunReply(run.id), relayTaskGraphRunReply(run.id)]);
    assert.equal(updated.length, 3, 'Concurrent relays must update once');
    assert.equal(sent.length, 1);
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: run.id }, data: { status: 'completed', summary: 'S03 已提交，等待验收。' } });
    await prisma.taskRun.update({ where: { id: run.id }, data: { status: 'completed', completedAt: new Date() } });
    await prisma.taskRunInteractionRequest.update({ where: { id: request.id }, data: { status: 'approved' } });
    await relayTaskGraphReplies();
    assert.match(JSON.stringify(updated.at(-1)?.card), /S03 已提交，等待验收/, 'Final reply must remain on the same card');
    const finalVisible = (updated.at(-1)?.card as { body: { elements: { tag: string; content?: string }[] } }).body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n');
    assert.doesNotMatch(finalVisible, /正在实现 S03/, 'Final body contains the answer only');
    assert.match(JSON.stringify(updated.at(-1)?.card), /正在实现 S03/, 'Progress stays in the collapsed history');
    assert.match(finalVisible, /S03 已提交，等待验收/);
    assert.equal(updated.at(-1)?.id, 'reply-1', 'Finalization keeps the streaming message identity');
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } })).lastStatus, 'completed');
    assert.equal(sent.length, 1);
    assert.equal(replies.length, 0, 'Final result must not create another card');
    assert.match(JSON.stringify(updated.at(-1)?.card), /执行完成/);
    assert.doesNotMatch(JSON.stringify(updated.at(-1)?.card), /Slice 已完成/);
    await relayTaskGraphReplies();
    assert.equal(replies.length, 0, 'The final result must not create a new reply');
    const marker = 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"environment_failed","note":"project environment missing"}';
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: run.id }, data: { summary: marker } });
    await relayTaskGraphRunReply(run.id, true);
    assert.match(JSON.stringify(updated.at(-1)?.card), /执行完成/);
    assert.match(JSON.stringify(updated.at(-1)?.card), /project environment missing/);
    assert.equal(sent.length, 1); assert.equal(replies.length, 0);
    const retry = await prisma.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'running',
      createdAt: new Date(Date.now() + 1000), events: { create: { sequence: 1, eventType: 'runner_started', content: '自动回修已启动' } } } });
    await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '这一轮为什么没有进度？' } });
    const previousCursor = await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } });
    await prisma.taskRunFeishuRelay.create({ data: { taskRunId: retry.id, bindingId: previousCursor.bindingId, messageId: 'reply-1', deliveredSequence: 1, lastStatus: 'running' } });
    await relayTaskGraphRunReply(retry.id);
    assert.equal(sent.length, 2, 'A new TaskRun posts a fresh progress card below the discussion');
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: retry.id } })).messageId, 'reply-2');
    await prisma.taskRunEvent.create({ data: { taskRunId: retry.id, sequence: 2, eventType: 'stdout_chunk', content: '本轮继续检查' } });
    await relayTaskGraphRunReply(retry.id);
    assert.equal(updated.at(-1)?.id, 'reply-2', 'Only the current run card is updated during its lifetime');
    assert.equal(sent.length, 2);
    const latestCard = updated.at(-1)?.card;
    assert.equal(await relayTaskGraphRunReply(run.id), false, 'An older TaskRun must not overwrite the current task card');
    assert.deepEqual(updated.at(-1)?.card, latestCard);
    console.log('Each TaskRun owns a new topic card; legacy shared cursors migrate, current output updates once, and superseded runs cannot overwrite it');
  } finally {
    api.sendFeishuInteractiveMessage = original.send; cards.updateFeishuTaskEntryCard = original.update; api.replyFeishuMessage = original.reply;
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
