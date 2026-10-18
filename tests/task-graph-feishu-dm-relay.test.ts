import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';
import { moveGraphReplyToChildTopic } from '../src/lib/task-graph/run-reply-migration';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'); const cards = require('../src/lib/feishu-task-entry-api');
  const original = { send: api.sendFeishuInteractiveMessage, update: cards.updateFeishuTaskEntryCard };
  const sent: { receiveId: string; threadRootMessageId?: string; uuid: string; card: unknown }[] = [];
  const updated: string[] = [];
  api.sendFeishuInteractiveMessage = async (args: typeof sent[number]) => { sent.push(args); return `group-card-${sent.length}`; };
  cards.updateFeishuTaskEntryCard = async (id: string) => { updated.push(id); };
  try {
    const parent = await prisma.task.create({ data: { name: 'DM approval' } });
    const room = await prisma.liveRoom.create({ data: { title: parent.name, sourceTaskId: parent.id } });
    const dm = await prisma.feishuConversationBinding.create({ data: { scopeKey: randomUUID(), liveRoomId: room.id,
      appId: 'test-bot', chatId: 'parent-dm', chatType: 'p2p' } });
    const child = await prisma.task.create({ data: { id: `task-graph-dm-${randomUUID()}`, name: 'R01 · reader' } });
    const graph = await prisma.taskGraphRun.create({ data: { parentTaskId: parent.id, version: 1,
      requestKey: randomUUID(), snapshotHash: 'a'.repeat(64), snapshot: {} } });
    const node = await prisma.taskGraphNode.create({ data: { runId: graph.id, key: 'R01', dependsOn: [], acceptance: 'automatic' } });
    await prisma.taskGraphExecution.create({ data: { nodeId: node.id, key: 'reader', repository: '/fixture/reader',
      gitRef: 'refs/heads/dev', baseCommit: 'b'.repeat(40), agentSelector: 'local:codex', childTaskId: child.id } });
    const run = await prisma.taskRun.create({ data: { taskId: child.id, mode: 'acpx', status: 'running',
      events: { create: { sequence: 1, eventType: 'stdout_chunk', content: '原屏合同进度' } } } });
    assert.equal(await relayTaskGraphRunReply(run.id), false, 'Detailed progress must not fall back to the approval DM');
    assert.equal(sent.length, 0);
    await prisma.taskRunFeishuRelay.create({ data: { taskRunId: run.id, bindingId: dm.id, messageId: 'historical-dm-card', deliveredSequence: 1, lastStatus: 'running' } });
    const topicRoom = await prisma.liveRoom.create({ data: { title: child.name, sourceTaskId: child.id } });
    const topic = await prisma.feishuConversationBinding.create({ data: { scopeKey: randomUUID(), liveRoomId: topicRoom.id,
      appId: 'test-bot', chatId: 'reader-project-group', chatType: 'group', rootMessageId: 'reader-topic-root', threadId: 'reader-topic' } });
    await assert.rejects(() => relayTaskGraphRunReply(run.id), /Reply target changed/);
    await moveGraphReplyToChildTopic(run.id, topic.id);
    await moveGraphReplyToChildTopic(run.id, topic.id);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'reply_target_migrated' } }), 1);
    const audit = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'reply_target_migrated' } });
    assert.match(JSON.stringify(audit.payload), /historical-dm-card/);
    assert.equal(await relayTaskGraphRunReply(run.id), true);
    assert.equal(sent[0].receiveId, 'reader-project-group'); assert.equal(sent[0].threadRootMessageId, 'reader-topic-root');
    assert.ok(sent[0].uuid.length <= 50); assert.notEqual(sent[0].uuid, `graph-run-reply-${run.id}`);
    await prisma.taskRunEvent.create({ data: { taskRunId: run.id, sequence: 2, eventType: 'stdout_chunk', content: '回归测试' } });
    await relayTaskGraphRunReply(run.id); assert.equal(sent.length, 1); assert.equal(updated.at(-1), 'group-card-1');
    const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${node.id}`, name: 'R01 acceptance' } });
    const review = await prisma.taskRun.create({ data: { taskId: reviewTask.id, mode: 'acpx', status: 'running' } });
    assert.equal(await relayTaskGraphRunReply(review.id), true); assert.equal(sent.at(-1)?.threadRootMessageId, 'reader-topic-root');
    await prisma.taskRun.updateMany({ where: { id: { in: [run.id, review.id] } }, data: { status: 'completed' } });
    await prisma.taskGraphRun.update({ where: { id: graph.id }, data: { status: 'completed' } });
    console.log('DM has no detail fallback; audited migration preserves old receipt; group updates are idempotent; acceptance uses child topic');
  } finally { api.sendFeishuInteractiveMessage = original.send; cards.updateFeishuTaskEntryCard = original.update; await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
