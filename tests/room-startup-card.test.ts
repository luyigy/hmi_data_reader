import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { processLiveRoomDelivery } from '../src/lib/live-room-delivery-processing';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^task_graph_test_/);
  const loadModule = createRequire(__filename);
  const api = loadModule('../src/lib/feishu-api');
  const updates = loadModule('../src/lib/feishu-task-entry-api');
  const runner = loadModule('../src/lib/acpx/runner');
  const relay = loadModule('../src/lib/feishu-live-room-relay');
  const originals = { send: api.sendFeishuInteractiveMessage, patch: updates.updateFeishuTaskEntryCard, run: runner.executeAcpxTaskRun, relay: relay.relayLiveRoomMessageToFeishu };
  const cards = new Map<string, object>();
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; card: object }) => { cards.set(args.uuid, args.card); return args.uuid; };
  updates.updateFeishuTaskEntryCard = async (id: string, card: object) => { cards.set(id, card); };
  relay.relayLiveRoomMessageToFeishu = async () => {};
  runner.executeAcpxTaskRun = async () => { throw Error('Workspace write conflict with active run protected-fixture'); };
  const task = await prisma.task.create({ data: { name: 'startup card', workingDirectory: process.cwd() } });
  const room = await prisma.liveRoom.create({ data: { title: 'startup card', sourceTaskId: task.id, workingDirectory: process.cwd() } });
  const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: room.id, liveRoomId: room.id, appId: 'fixture', chatId: 'fixture-chat', chatType: 'group' } });
  try {
    for (const harnessType of ['codex', 'antigravity']) {
      const member = await prisma.liveRoomMember.create({ data: { roomId: room.id, displayName: harnessType, harnessType, backend: 'platform_local', memberType: 'local_agent', runtimeAgentId: harnessType, canReply: true } });
      const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'check status', metadata: JSON.stringify({ feishuBindingId: binding.id }) } });
      const delivery = await prisma.liveRoomDelivery.create({ data: { roomMessageId: message.id, targetMemberId: member.id } });
      await processLiveRoomDelivery({ deliveryId: delivery.id, roomId: room.id, roomMessageId: message.id, targetMemberId: member.id, chainDepth: 0 });
      const saved = await prisma.feishuTurnCard.findFirstOrThrow({ where: { sourceMessageId: message.id, memberId: member.id } });
      assert.equal(saved.terminal, true);
      assert.match(saved.cardJson!, /Workspace write conflict with active run protected-fixture/, 'startup failure must retain its actual cause');
      assert.match(JSON.stringify(cards.get(saved.messageId!)), /protected-fixture/);
      assert.equal((await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).fallbackReason, 'Workspace write conflict with active run protected-fixture');
    }
    // Closing a tracker must drain existing updates and suppress delayed writes, without publishing a terminal card.
    const published: boolean[] = [];
    const tracker = new FeishuProgressTracker({ chatId: 'fixture-chat' }, undefined, 'fixture', async (_card, final) => { published.push(final); return 'fixture'; });
    await tracker.setReplyContent('initial', '', '');
    await tracker.setReplyContent('delayed', '', '');
    await tracker.stop();
    const count = published.length;
    await tracker.setReplyContent('late', '', '');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(published.length, count);
    assert.ok(!published.includes(true));
    console.log('PASS startup failure actual cause on original Codex/Antigravity cards; progress cleanup does not finalize or overwrite');
  } finally {
    api.sendFeishuInteractiveMessage = originals.send; updates.updateFeishuTaskEntryCard = originals.patch;
    runner.executeAcpxTaskRun = originals.run; relay.relayLiveRoomMessageToFeishu = originals.relay;
    await prisma.feishuTurnCard.deleteMany({ where: { bindingId: binding.id } });
    await prisma.feishuConversationBinding.delete({ where: { id: binding.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: task.id } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
