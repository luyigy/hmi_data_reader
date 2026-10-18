import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.match(url.searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api');
  const cards = require('../src/lib/feishu-task-entry-api');
  const original = { send: api.sendFeishuInteractiveMessage, update: cards.updateFeishuTaskEntryCard };
  const sent: { receiveId: string; threadRootMessageId?: string; card: unknown }[] = [];
  const updated: { id: string; card: unknown }[] = [];
  api.sendFeishuInteractiveMessage = async (args: typeof sent[number]) => {
    sent.push(args); return `dm-card-${sent.length}`;
  };
  cards.updateFeishuTaskEntryCard = async (id: string, card: unknown) => { updated.push({ id, card }); };
  try {
    const parent = await prisma.task.create({ data: { name: 'DM approved route' } });
    const room = await prisma.liveRoom.create({ data: { title: parent.name, sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: randomUUID(), liveRoomId: room.id,
      appId: 'test-bot', chatId: 'approved-parent-dm', chatType: 'p2p' } });
    const child = await prisma.task.create({ data: { id: `task-graph-dm-${randomUUID()}`, name: 'R01 · reader' } });
    const graph = await prisma.taskGraphRun.create({ data: { parentTaskId: parent.id, version: 1,
      requestKey: randomUUID(), snapshotHash: 'a'.repeat(64), snapshot: {} } });
    const node = await prisma.taskGraphNode.create({ data: { runId: graph.id, key: 'R01', dependsOn: [], acceptance: 'automatic' } });
    await prisma.taskGraphExecution.create({ data: { nodeId: node.id, key: 'reader', repository: '/fixture/reader',
      gitRef: 'refs/heads/dev', baseCommit: 'b'.repeat(40), agentSelector: 'local:codex', childTaskId: child.id } });
    const run = await prisma.taskRun.create({ data: { taskId: child.id, mode: 'acpx', status: 'running',
      events: { create: { sequence: 1, eventType: 'stdout_chunk', content: '已开始核对 Reader 原屏合同。' } } } });
    assert.equal(await relayTaskGraphRunReply(run.id), true, 'An approved DM child must have visible progress without a group topic');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].receiveId, 'approved-parent-dm');
    assert.equal(sent[0].threadRootMessageId, undefined, 'DM delivery must not invent a group thread root');
    assert.match(JSON.stringify(sent[0].card), /R01.*reader/);
    assert.match(JSON.stringify(sent[0].card), /已开始核对 Reader/);
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 2, eventType: 'stdout_chunk', content: '正在执行回归。' } });
    assert.equal(await relayTaskGraphRunReply(run.id), true);
    assert.equal(sent.length, 1, 'DM progress must patch its original card');
    assert.equal(updated.at(-1)?.id, 'dm-card-1');
    assert.equal(await relayTaskGraphRunReply(run.id), false);
    const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${node.id}`, name: 'R01 acceptance' } });
    const review = await prisma.taskRun.create({ data: { taskId: reviewTask.id, mode: 'acpx', status: 'running' } });
    assert.equal(await relayTaskGraphRunReply(review.id), true, 'DM acceptance must resolve the same approved parent');
    assert.equal(sent.at(-1)?.receiveId, 'approved-parent-dm');
    const orphan = await prisma.task.create({ data: { id: `task-graph-orphan-${randomUUID()}`, name: 'Unrelated task' } });
    const orphanRun = await prisma.taskRun.create({ data: { taskId: orphan.id, mode: 'acpx', status: 'running' } });
    assert.equal(await relayTaskGraphRunReply(orphanRun.id), false, 'An unrelated task must not fall back to an arbitrary DM');
    assert.equal(sent.length, 2);
    console.log('DM child and acceptance progress reach the approved parent; updates reuse the card; unrelated tasks stay private');
  } finally {
    api.sendFeishuInteractiveMessage = original.send;
    cards.updateFeishuTaskEntryCard = original.update;
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
