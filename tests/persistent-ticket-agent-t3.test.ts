import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { pendingConversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { setGraphRunPaused } from '../src/lib/task-graph/run-control';
import { buildGraphOverview, handleGraphOverviewAction, loadGraphOverview, publishGraphOverview } from '../src/lib/task-graph/overview';
import { postGraphParentProgress } from '../src/lib/task-graph/feishu';
import { relayLiveRoomMessageToFeishu } from '../src/lib/feishu-live-room-relay';
import { graphFormAction } from '../src/lib/task-graph/card-actions';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'overview-operator';
  const require = createRequire(__filename), api = require('../src/lib/feishu-api'), cards = require('../src/lib/feishu-task-entry-api');
  let sends = 0, updates = 0, textSends = 0;
  api.sendFeishuTextMessage = async () => { textSends++; return 'unexpected-parent-text'; };
  api.sendFeishuInteractiveMessage = async () => { sends++; return 'om_fixture_overview'; };
  cards.updateFeishuTaskEntryCard = async () => { updates++; };
  const parent = await prisma.task.create({ data: { name: `overview-${randomUUID()}` } });
  const room = await prisma.liveRoom.create({ data: { title: 'parent', sourceTaskId: parent.id } });
  const binding = await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, chatId: 'overview-chat', appId: 'fixture', scopeKey: parent.id, chatType: 'p2p' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://overview', nodes: Array.from({ length: 8 }, (_, index) => ({ key: `T${index}`, goal: `Ticket ${index}`, dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
      executions: [{ key: 'repo', repository: '/tmp/overview-fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] })),
  } });
  const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, orderBy: { createdAt: 'asc' } });
  const child = await prisma.task.create({ data: { name: 'original Ticket' } });
  const childRoom = await prisma.liveRoom.create({ data: { title: 'original Topic', sourceTaskId: child.id } });
  await prisma.taskGraphExecution.update({ where: { id: jobs[0].id }, data: { childTaskId: child.id } });
  const value = { runId: run.id, hash: run.snapshotHash, action: 'reply' };
  const action = { value, form: { execution: jobs[0].id, reply: '尺寸45，继续已批准工作' }, openId: 'overview-operator', chatId: 'overview-chat', messageId: 'om_fixture_overview', callbackId: 'callback-one' };
  try {
    const first = buildGraphOverview(await loadGraphOverview(run.id));
    assert.match(JSON.stringify(first), /回复哪个任务|原 Agent/);
    assert.match(first.header.title.content, /1\/2/);
    assert.deepEqual(graphFormAction(`tgo:r:${run.id}:${run.snapshotHash}`), { cmd: 'task-graph-overview', action: 'reply', runId: run.id, hash: run.snapshotHash });
    assert.equal(await publishGraphOverview(run.id), true); assert.equal(await publishGraphOverview(run.id), false); assert.equal(sends, 1);
    await postGraphParentProgress(parent.id, run.id, 'T0/repo 已启动');
    await postGraphParentProgress(parent.id, run.id, 'T0/repo 下一轮已启动');
    const progressMessages = await prisma.liveRoomMessage.findMany({ where: { roomId: room.id, messageType: 'system' } });
    assert.equal(progressMessages.length, 2, 'Internal progress history remains available');
    for (const saved of progressMessages) await relayLiveRoomMessageToFeishu({
      id: saved.id, roomId: room.id, senderMemberId: null, senderName: 'system', senderLabel: 'system', senderType: 'system',
      content: saved.content, messageType: 'system', visibility: 'room', topicSnapshot: null, createdAt: saved.createdAt.toISOString(),
      replyToMessageId: null, metadata: JSON.parse(saved.metadata || '{}'),
    });
    assert.equal(textSends, 0, 'Repeated child turns must not send parent text messages');
    assert.equal(sends, 1, 'The parent has one overview card');
    await assert.rejects(handleGraphOverviewAction({ ...action, openId: 'other-user' }), /Only the task operator/);
    await assert.rejects(handleGraphOverviewAction({ ...action, chatId: 'another-chat' }), /identity changed/);
    await assert.rejects(handleGraphOverviewAction({ ...action, value: { ...value, hash: '0'.repeat(64) } }), /identity changed/);
    await assert.rejects(handleGraphOverviewAction({ ...action, form: { ...action.form, execution: 'forged-execution' } }));
    await prisma.feishuConversationBinding.update({ where: { id: binding.id }, data: { rootMessageId: 'rebound-topic' } });
    await assert.rejects(handleGraphOverviewAction(action), /destination changed/);
    await assert.rejects(publishGraphOverview(run.id), /destination changed/);
    await prisma.feishuConversationBinding.update({ where: { id: binding.id }, data: { rootMessageId: null } });
    const paused = { runId: run.id, paused: true, requestId: 'operator-pause', actorId: 'overview-operator', reason: 'maintenance' };
    await setGraphRunPaused(paused);
    await handleGraphOverviewAction(action); await handleGraphOverviewAction(action);
    assert.equal(await prisma.liveRoomMessage.count({ where: { roomId: childRoom.id, messageType: 'user' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'conversation_input' } }), 1);
    assert.deepEqual(await pendingConversationInputs(prisma, run.id, jobs[0].id), [], 'Paused route stores a reply without consuming it');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'notification_requested' } }), 1, 'Original Topic mirror is an idempotent outbox item');
    await assert.rejects(handleGraphOverviewAction({ ...action, form: { ...action.form, reply: 'changed content' } }), /identity reused/);
    const page = await handleGraphOverviewAction({ ...action, value: { ...value, action: 'page', page: 1 }, callbackId: 'page-two' });
    assert.ok('card' in page && page.card); assert.match(JSON.stringify(page.card), /2\/2/);
    const current = await loadGraphOverview(run.id);
    await setGraphRunPaused({ ...paused, requestId: 'pause-newer' });
    await assert.rejects(handleGraphOverviewAction({ ...action, value: { ...value, action: 'resume', controlVersion: current.controlVersion }, callbackId: 'stale-continue' }), /control changed/);
    const fresh = await loadGraphOverview(run.id);
    await handleGraphOverviewAction({ ...action, value: { ...value, action: 'resume', controlVersion: fresh.controlVersion }, callbackId: 'explicit-continue' });
    const input = await pendingConversationInputs(prisma, run.id, jobs[0].id);
    assert.equal(input.length, 1); assert.equal(input[0].content, action.form.reply); assert.equal(input[0].actorOrigin, 'feishu');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'conversation_input', payload: { path: ['executionId'], equals: jobs[1].id } } }), 0);
    await publishGraphOverview(run.id); assert.equal(sends, 1); assert.ok(updates >= 1);
    console.log('T3: exact parent card/operator, pagination, original-room input and mirror, replay/tamper rejection, pause-safe storage, stale control rejection and explicit resume');
  } finally { await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.liveRoom.delete({ where: { id: childRoom.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } }); await prisma.task.delete({ where: { id: child.id } }); await prisma.task.delete({ where: { id: parent.id } }); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
