import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { reserveTurnCard, publishTurnCard, finishOwnedTurnCard, relayPendingTurnCards, bindTurnCardRun, failRoomTurnCard } from '../src/lib/feishu-turn-card';
import { relayLiveRoomMessageToFeishu } from '../src/lib/feishu-live-room-relay';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'), updates = require('../src/lib/feishu-task-entry-api');
  const originals = { send: api.sendFeishuInteractiveMessage, update: updates.updateFeishuTaskEntryCard };
  const messages = new Map<string, { id: string; card: object }>();
  const patches: string[] = [];
  let failUpdate = false, loseReceipt = false;
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; card: object }) => {
    if (!messages.has(args.uuid)) messages.set(args.uuid, { id: `card-${messages.size + 1}`, card: args.card });
    if (loseReceipt) { loseReceipt = false; throw new Error('response lost'); }
    return messages.get(args.uuid)!.id;
  };
  updates.updateFeishuTaskEntryCard = async (id: string, card: object) => {
    if (failUpdate) throw new Error('patch unavailable');
    const message = Array.from(messages.values()).find(m => m.id === id)!;
    message.card = card; patches.push(id);
  };
  const room = await prisma.liveRoom.create({ data: { title: 'one card fixture' } });
  const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: room.id, liveRoomId: room.id, appId: 'fixture', chatId: 'chat', chatType: 'group', rootMessageId: 'root', threadId: 'thread' } });
  const source = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'two agents' } });
  const a = await prisma.liveRoomMember.create({ data: { roomId: room.id, displayName: 'A' } });
  const b = await prisma.liveRoomMember.create({ data: { roomId: room.id, displayName: 'B' } });
  const identities = [a, b].map(member => ({ sourceMessageId: source.id, memberId: member.id, bindingId: binding.id }));
  const card = (text: string) => ({ elements: [{ tag: 'markdown', content: text }] });
  const task = await prisma.task.create({ data: { name: 'recovery fixture' } });
  try {
    for (const identity of identities) { await reserveTurnCard(identity); await publishTurnCard(identity, card('running'), false); }
    await publishTurnCard(identities[1], card('B final'), true);
    await publishTurnCard(identities[0], card('A final'), true);
    assert.equal(messages.size, 2, 'Reverse completion edits the two original cards');
    assert.deepEqual(patches, ['card-2', 'card-1']);
    await publishTurnCard(identities[0], card('late stream'), false);
    assert.match(JSON.stringify(Array.from(messages.values())[0].card), /A final/);
    await relayLiveRoomMessageToFeishu({ id: 'final', roomId: room.id, senderMemberId: a.id, senderName: 'A', senderLabel: 'A', senderType: 'assistant', content: 'A final', messageType: 'assistant', visibility: 'room', topicSnapshot: null, createdAt: new Date().toISOString(), replyToMessageId: source.id, metadata: { feishuBindingId: binding.id } });
    assert.equal(messages.size, 2, 'Ordinary final relay must not send another receipt card');

    const second = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'new round' } });
    const identity = { ...identities[0], sourceMessageId: second.id };
    const row = await reserveTurnCard(identity);
    loseReceipt = true;
    await assert.rejects(publishTurnCard(identity, card('initial'), false), /response lost/);
    await relayPendingTurnCards();
    assert.equal(messages.size, 3, 'Lost HTTP response must reuse the original UUID');
    failUpdate = true;
    await assert.rejects(publishTurnCard(identity, card('final persisted'), true), /patch unavailable/);
    assert.equal((await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: row.id } })).pending, true);
    failUpdate = false;
    await relayPendingTurnCards();
    assert.equal(messages.size, 3);
    assert.match(JSON.stringify(Array.from(messages.values())[2].card), /final persisted/);
    assert.equal(await finishOwnedTurnCard(identity), true);

    await prisma.feishuConversationBinding.update({ where: { id: binding.id }, data: { rootMessageId: 'different-root' } });
    await prisma.feishuTurnCard.update({ where: { id: row.id }, data: { pending: true } });
    await relayPendingTurnCards();
    assert.equal((await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: row.id } })).pending, true, 'Changed topic cannot redirect the original card');
    await prisma.feishuConversationBinding.update({ where: { id: binding.id }, data: { rootMessageId: 'root' } });

    const third = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'restart' } });
    const recoveryIdentity = { ...identity, sourceMessageId: third.id };
    const recovery = await reserveTurnCard(recoveryIdentity);
    await publishTurnCard(recoveryIdentity, card('running before restart'), false);
    const run = await prisma.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'completed', summary: 'Recovered final' } });
    await bindTurnCardRun(recoveryIdentity, run.id);
    await relayPendingTurnCards();
    assert.equal((await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: recovery.id } })).terminal, false, 'Living owner retains finalization even when a retry attempt ended');
    await prisma.feishuTurnCard.update({ where: { id: recovery.id }, data: { ownerJson: JSON.stringify({ pid: 99999999, startTime: '1', hostname: os.hostname(), bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }) } });
    await relayPendingTurnCards();
    assert.equal((await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: recovery.id } })).terminal, true);
    assert.equal(messages.size, 4, 'Restart recovery finalizes the original card');
    assert.match(JSON.stringify(Array.from(messages.values())[3].card), /Recovered final/);
    const failedSource = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'startup fails' } });
    const failedIdentity = { ...identity, sourceMessageId: failedSource.id };
    await reserveTurnCard(failedIdentity);
    await publishTurnCard(failedIdentity, card('waiting'), false);
    assert.equal(await failRoomTurnCard(failedSource.id, a.id, 'startup error'), true);
    assert.equal(messages.size, 5);
    assert.match(JSON.stringify(Array.from(messages.values())[4].card), /startup error/);
    const fallbackSource = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'final relay recovery' } });
    const fallbackIdentity = { ...identity, sourceMessageId: fallbackSource.id };
    await reserveTurnCard(fallbackIdentity);
    await publishTurnCard(fallbackIdentity, card('waiting'), false);
    await finishOwnedTurnCard(fallbackIdentity, { text: 'Final from room ledger', footnotes: ['input 123 tokens'] });
    assert.equal(messages.size, 6);
    assert.match(JSON.stringify(Array.from(messages.values())[5].card), /Final from room ledger.*123/);
    const cancelled = await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'cancelled before start' } });
    const cancelledIdentity = { ...identity, sourceMessageId: cancelled.id };
    await reserveTurnCard(cancelledIdentity);
    await publishTurnCard(cancelledIdentity, card('waiting'), false);
    await prisma.liveRoomDelivery.create({ data: { roomMessageId: cancelled.id, targetMemberId: a.id, deliveryStatus: 'superseded', fallbackReason: 'Session changed before delivery' } });
    await relayPendingTurnCards();
    assert.equal(messages.size, 7, 'A cancelled queue entry terminates its existing placeholder');
    assert.match(JSON.stringify(Array.from(messages.values())[6].card), /Session changed before delivery/);
    console.log('Durable cards: reverse completion, no second receipt, late deltas, lost response, failed PATCH, restart, recipient and topic isolation passed');
  } finally {
    api.sendFeishuInteractiveMessage = originals.send; updates.updateFeishuTaskEntryCard = originals.update;
    await prisma.feishuTurnCard.deleteMany({ where: { bindingId: binding.id } });
    await prisma.feishuConversationBinding.delete({ where: { id: binding.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: task.id } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
