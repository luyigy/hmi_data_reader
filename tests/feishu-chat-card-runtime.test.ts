import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { prepareRoomTurnCard, reserveTurnCard, publishTurnCard, bindTurnCardRun } from '../src/lib/feishu-turn-card';
import { startFeishuLongConnectionRuntime, shutdownFeishuRuntime } from '../src/lib/feishu-long-connection';
import { relayTaskGraphReplies } from '../src/lib/task-graph/run-reply-relay';

async function eventually(check: () => Promise<boolean>, message: string) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'), updates = require('../src/lib/feishu-task-entry-api');
  const connection = require('../src/lib/feishu-connection-supervisor');
  const roomCreation = require('../src/lib/feishu-room-create-card');
  const runtimeStatus = require('../src/lib/feishu-runtime-status');
  const messages = new Map<string, { id: string; card: object }>();
  const patches: string[] = [];
  let loseReceipt = false, failUpdate = false, connections = 0;
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; card: object }) => {
    if (!messages.has(args.uuid)) messages.set(args.uuid, { id: `chat-card-${messages.size + 1}`, card: args.card });
    if (loseReceipt) { loseReceipt = false; throw new Error('response lost'); }
    return messages.get(args.uuid)!.id;
  };
  updates.updateFeishuTaskEntryCard = async (id: string, card: object) => {
    if (failUpdate) throw new Error('patch unavailable');
    const message = Array.from(messages.values()).find(m => m.id === id);
    assert.ok(message, 'PATCH must refer to an existing card');
    message.card = card; patches.push(id);
  };
  api.sendFeishuTextMessage = async () => { assert.fail('Chat card recovery must not send a replacement text message'); };
  connection.startFeishuConnectionSupervisor = () => { connections++; };
  connection.stopFeishuConnectionSupervisor = () => {};
  roomCreation.primeFeishuRoomCreationAgents = async () => {};
  runtimeStatus.updateFeishuRuntimeStatus = (value: object) => runtimeStatus.createFeishuRuntimeStatus(value);
  runtimeStatus.readFeishuRuntimeStatus = () => null;
  process.env.FEISHU_APP_ID = 'fixture'; process.env.FEISHU_APP_SECRET = 'fixture';
  process.env.FEISHU_CONNECTION_MODE = 'long_connection';
  const task = await prisma.task.create({ data: { id: `task-graph-manual-${Date.now()}`, name: 'Manual discussion about M06' } });
  const room = await prisma.liveRoom.create({ data: { title: 'manual chat', sourceTaskId: task.id } });
  const member = await prisma.liveRoomMember.create({ data: { roomId: room.id, displayName: 'Codex' } });
  const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: room.id, liveRoomId: room.id,
    appId: 'fixture', chatId: 'chat', chatType: 'group', rootMessageId: 'manual-root' } });
  const source = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'M06 为什么失败？这里只讨论资源申请格式。' } });
  const identity = { sourceMessageId: source.id, memberId: member.id, bindingId: binding.id };
  const card = (text: string) => ({ elements: [{ tag: 'markdown', content: text }] });
  const row = await reserveTurnCard(identity);
  let started = false;
  try {
    loseReceipt = true;
    await assert.rejects(publishTurnCard(identity, card('initial'), false), /response lost/);
    started = true;
    await startFeishuLongConnectionRuntime();
    await startFeishuLongConnectionRuntime();
    assert.equal(connections, 1, 'Repeated runtime start must retain the same lifecycle');
    await eventually(async () => !(await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: row.id } })).pending,
      'Chat runtime must recover a lost send receipt without a task graph worker');
    assert.equal(messages.size, 1);
    assert.ok(await prepareRoomTurnCard(source.id, member.id), 'A task name prefix is not a graph binding');
    failUpdate = true;
    await assert.rejects(publishTurnCard(identity, card('final first answer'), true), /patch unavailable/);
    failUpdate = false;
    await eventually(async () => !(await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: row.id } })).pending,
      'Chat runtime must retry the original card PATCH');
    assert.equal(messages.size, 1);
    assert.match(JSON.stringify(Array.from(messages.values())[0].card), /final first answer/);
    const followup = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: '再解释一下，不恢复 M06。' } });
    const followupIdentity = { ...identity, sourceMessageId: followup.id };
    const second = await reserveTurnCard(followupIdentity);
    await publishTurnCard(followupIdentity, card('before restart'), false);
    const run = await prisma.taskRun.create({ data: { taskId: task.id, status: 'completed', summary: 'Recovered followup in original session\nTASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"Example only"}' } });
    await bindTurnCardRun(followupIdentity, run.id);
    await prisma.feishuTurnCard.update({ where: { id: second.id }, data: { ownerJson: JSON.stringify({ pid: 99999999,
      startTime: '1', hostname: os.hostname(), bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }) } });
    await eventually(async () => (await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: second.id } })).terminal,
      'Chat runtime must finalize an exited owner on the same card');
    assert.equal(messages.size, 2);
    assert.match(JSON.stringify(Array.from(messages.values())[1].card), /Recovered followup/);
    assert.match(JSON.stringify(Array.from(messages.values())[1].card), /TASK_GRAPH_IMPLEMENTATION/,
      'Manual recovery preserves graph protocol examples as ordinary text');
    const before = patches.length;
    await relayTaskGraphReplies();
    assert.equal(messages.size, 2, 'Graph consumer cannot claim a manual task with a graph-like name');
    assert.equal(patches.length, before, 'Graph consumer cannot update manual cards');
    assert.equal(await prisma.taskRunFeishuRelay.count({ where: { taskRunId: run.id } }), 0);
    assert.equal(await prisma.taskGraphEvent.count(), 0, 'Ordinary messages do not create graph state');
    await shutdownFeishuRuntime(); started = false;
    const third = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'restart recovery' } });
    const thirdIdentity = { ...identity, sourceMessageId: third.id };
    const pending = await reserveTurnCard(thirdIdentity);
    loseReceipt = true;
    await assert.rejects(publishTurnCard(thirdIdentity, card('after stopped'), true), /response lost/);
    await new Promise(resolve => setTimeout(resolve, 1_700));
    assert.equal((await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: pending.id } })).pending, true,
      'Stopped chat runtime no longer drains cards');
    started = true; await startFeishuLongConnectionRuntime();
    await eventually(async () => !(await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: pending.id } })).pending,
      'Restarted chat runtime resumes pending delivery without graph services');
    assert.equal(messages.size, 3);
    console.log('Chat-only runtime: lost receipt, PATCH retry, original-card finalization, two turns, graph isolation and restart PASS (Feishu transport simulated)');
  } finally {
    if (started) await shutdownFeishuRuntime();
    await prisma.feishuTurnCard.deleteMany({ where: { bindingId: binding.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: task.id } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
