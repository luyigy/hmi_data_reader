import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { deliverGraphChildProgress, postGraphChildProgress } from '../src/lib/task-graph/feishu';
import { relayTaskGraphReplies, relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'), entry = require('../src/lib/feishu-task-entry-api');
  const sends = new Map<string, string>(); const attempts: string[] = []; const updates: { id: string; card: unknown }[] = [];
  let loseResponse = false;
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; receiveId: string }) => {
    assert.equal(args.receiveId, 'repo-group'); attempts.push(args.uuid);
    if (!sends.has(args.uuid)) sends.set(args.uuid, `card-${sends.size}`);
    if (loseResponse) { loseResponse = false; throw new Error('accepted response lost'); }
    return sends.get(args.uuid);
  };
  entry.updateFeishuTaskEntryCard = async (id: string, card: unknown) => { updates.push({ id, card }); };
  const fixture = async () => {
    const parent = await prisma.task.create({ data: { name: 'card closure' } });
    const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: randomUUID(), definition: {
      specRef: 'fixture://card', nodes: [{ key: 'N', goal: 'fixture', dependsOn: [], executionMode: 'implement',
        acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/card-fixture', gitRef: 'refs/heads/main',
          baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }],
    } });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
    const task = await prisma.task.create({ data: { id: `task-graph-card-${randomUUID()}`, name: 'card job' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id } });
    const room = await prisma.liveRoom.create({ data: { title: task.name, sourceTaskId: task.id } });
    const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: task.id, liveRoomId: room.id, appId: 'fixture',
      chatId: 'repo-group', chatType: 'group', rootMessageId: `topic-${task.id}` } });
    return { graph, job, task, binding };
  };
  const run = (taskId: string, createdAt = new Date()) => prisma.taskRun.create({ data: { taskId, status: 'completed', createdAt,
    completedAt: new Date(0), summary: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implementation done","evidence":["code"]}' } });
  try {
    const first = await fixture();
    await postGraphChildProgress(first.task.id, 'input-missing', '缺少必要输入。请补充原图。');
    await deliverGraphChildProgress(first.task.id, 'input-missing', '缺少必要输入。请补充原图。');
    const before = sends.size;
    const started = await run(first.task.id);
    await relayTaskGraphRunReply(started.id, true);
    assert.equal(sends.size, before, 'A pause before TaskRun and subsequent resume must share one card');
    assert.equal(updates.at(-1)?.id, [...sends.values()].at(-1));

    const lost = await fixture(); loseResponse = true;
    await assert.rejects(deliverGraphChildProgress(lost.task.id, 'input', '等待输入'), /accepted response lost/);
    const lostRun = await run(lost.task.id);
    const beforeLost = sends.size;
    await relayTaskGraphRunReply(lostRun.id, true);
    assert.equal(sends.size, beforeLost, 'Fallback timeout and TaskRun retry must use the same send UUID');

    const expired = await fixture(); loseResponse = true;
    await assert.rejects(deliverGraphChildProgress(expired.task.id, 'input', '等待输入'), /accepted response lost/);
    await prisma.taskGraphEvent.updateMany({ where: { runId: expired.graph.id, kind: 'notification_send_started' }, data: { createdAt: new Date(0) } });
    const expiredRun = await run(expired.task.id), beforeExpired = attempts.length;
    await assert.rejects(relayTaskGraphRunReply(expiredRun.id, true), /reconcile|uncertain/);
    assert.equal(attempts.length, beforeExpired, 'The first TaskRun must not reset the original uncertain-send age');

    const backlog = await fixture();
    for (let index = 0; index < 100; index++) {
      const old = await run(backlog.task.id, new Date(index));
      await prisma.taskRunFeishuRelay.create({ data: { taskRunId: old.id, bindingId: backlog.binding.id, lastStatus: 'running', messageId: 'existing-card' } });
    }
    const newest = await run(backlog.task.id);
    await relayTaskGraphRunReply(newest.id, true);
    await relayTaskGraphReplies();
    assert.equal(await prisma.taskRunFeishuRelay.count({ where: { bindingId: backlog.binding.id, lastStatus: 'superseded' } }), 100,
      'Completed cursors with a failed final update must retire after another run owns the card');
    const fresh = await fixture(), freshRun = await run(fresh.task.id);
    await relayTaskGraphReplies();
    assert.ok((await prisma.taskRunFeishuRelay.findUnique({ where: { taskRunId: freshRun.id } }))?.messageId,
      'One hundred superseded cursors must not starve a new topic');

    await prisma.taskGraphExecution.update({ where: { id: first.job.id }, data: { dispatchMetadata: { progress: {
      ...initialExecutionProgress(), phase: 'integrate', state: 'waiting_decision',
      lastFailure: { code: 'integration_conflict', detail: 'shared.txt 存在冲突。请确认采用哪项业务规则。' },
    } } } });
    await prisma.taskGraphNode.update({ where: { id: first.job.nodeId }, data: { status: 'attention' } });
    await deliverGraphChildProgress(first.task.id, 'conflict', 'shared.txt 存在冲突。请确认采用哪项业务规则。');
    const card = JSON.stringify(updates.at(-1)?.card);
    assert.match(card, /shared.txt/); assert.match(card, /请确认采用哪项业务规则/); assert.match(card, /需决定/);
    console.log('One card survives pre-run pause and lost responses; expired uncertainty is retained; 100 superseded cursors cannot starve delivery; current failure reaches the folded card');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
