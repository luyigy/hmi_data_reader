import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { deliverGraphChildProgress, postGraphChildProgress } from '../src/lib/task-graph/feishu';
import { relayTaskGraphReplies, relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';
import { publishGraphOverview } from '../src/lib/task-graph/overview';
import { receiveGraphTaskMessage, conversationInputs, conversationPrompt } from '../src/lib/task-graph/conversation-inbox';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api'), entry = require('../src/lib/feishu-task-entry-api');
  const sends = new Map<string, string>(); const attempts: string[] = []; const updates: { id: string; card: unknown }[] = [];
  const rendered: ReturnType<typeof buildRunReplyCard>[] = [];
  const textReplies: { content: { text: string } }[] = [];
  api.replyFeishuMessage = async (args: { content: { text: string } }) => { textReplies.push(args); return 'failure-message'; };
  const taskIds: string[] = [], graphIds: string[] = [], roomIds: string[] = [];
  let loseResponse = false;
  let onSend: (() => Promise<void>) | undefined;
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; receiveId: string; card: ReturnType<typeof buildRunReplyCard> }) => {
    rendered.push(args.card);
    assert.equal(args.receiveId, 'repo-group'); attempts.push(args.uuid);
    if (!sends.has(args.uuid)) sends.set(args.uuid, `card-${sends.size}`);
    await onSend?.();
    if (loseResponse) { loseResponse = false; throw new Error('accepted response lost'); }
    return sends.get(args.uuid);
  };
  entry.updateFeishuTaskEntryCard = async (id: string, card: ReturnType<typeof buildRunReplyCard>) => { updates.push({ id, card }); rendered.push(card); };
  const fixture = async () => {
    const parent = await prisma.task.create({ data: { name: 'card closure' } });
    taskIds.push(parent.id);
    const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: randomUUID(), definition: {
      specRef: 'fixture://card', nodes: [{ key: 'N', goal: 'fixture', dependsOn: [], executionMode: 'implement',
        acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/card-fixture', gitRef: 'refs/heads/main',
          baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }],
    } });
    graphIds.push(graph.id);
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
    const task = await prisma.task.create({ data: { id: `task-graph-card-${randomUUID()}`, name: 'card job' } });
    taskIds.push(task.id);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id } });
    const room = await prisma.liveRoom.create({ data: { title: task.name, sourceTaskId: task.id } });
    roomIds.push(room.id);
    const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: task.id, liveRoomId: room.id, appId: 'fixture',
      chatId: 'repo-group', chatType: 'group', rootMessageId: `topic-${task.id}` } });
    return { graph, job, task, binding };
  };
  const run = (taskId: string, createdAt = new Date()) => prisma.taskRun.create({ data: { taskId, status: 'completed', createdAt,
    completedAt: new Date(0), summary: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implementation done","evidence":["code"]}' } });
  try {
    const first = await fixture();
    const input = { taskId: first.task.id, sourceId: 'human-message', actorId: 'operator', actorOrigin: 'feishu' as const,
      content: '请检查原图\n然后说明具体原因。', sourceMetadata: '{"image":"fixture.png"}' };
    await Promise.all([receiveGraphTaskMessage(input), receiveGraphTaskMessage(input)]);
    const pending = await conversationInputs(first.job.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].content, input.content);
    assert.equal(pending[0].sourceMetadata, input.sourceMetadata);
    assert.ok(conversationPrompt(pending).includes(JSON.stringify(input.content)));
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: first.graph.id, kind: 'notification_requested' } }), 0);
    assert.equal(await deliverGraphChildProgress(first.task.id, 'conversation:queued:old', '旧入队提示'), true);
    assert.equal(await deliverGraphChildProgress(first.task.id, 'conversation:overview-reply:old', '旧转交提示'), true);
    assert.equal(sends.size, 0, 'New input and old queued notices do not produce cards');
    assert.equal(textReplies.length, 0, 'Transport notices must not become text replies either');
    await deliverGraphChildProgress(first.task.id, 'conversation:deferred:failed', '原会话连接失败：ECONNREFUSED');
    await deliverGraphChildProgress(first.task.id, 'reply-image-failed:run', '图片上传失败：file missing');
    assert.match(textReplies[0].content.text, /ECONNREFUSED/);
    assert.match(textReplies[1].content.text, /file missing/);

    await postGraphChildProgress(first.task.id, 'input-missing', '缺少必要输入。请补充原图。');
    await deliverGraphChildProgress(first.task.id, 'input-missing', '缺少必要输入。请补充原图。');
    const before = sends.size;
    const started = await run(first.task.id);
    await relayTaskGraphRunReply(started.id, true);
    assert.equal(sends.size, before + 1, 'A started TaskRun owns a new card after the pre-run pause');
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: started.id } })).messageId, Array.from(sends.values()).at(-1));

    await prisma.taskGraphExecution.update({ where: { id: first.job.id }, data: { dispatchMetadata: { progress: {
      ...initialExecutionProgress(), phase: 'check', repairAttempts: 1,
    } } } });
    const beforePhase = sends.size;
    assert.equal(await relayTaskGraphRunReply(started.id), false, 'Ticket phase changes do not rewrite completed replies');
    assert.equal(sends.size, beforePhase);

    const late = await fixture();
    const implementation = await run(late.task.id);
    await prisma.taskRun.update({ where: { id: implementation.id }, data: { status: 'running' } });
    await prisma.taskRunParticipant.create({ data: { taskRunId: implementation.id, gatewayNameSnapshot: 'Local', harnessType: 'codex', role: 'implementer' } });
    await relayTaskGraphRunReply(implementation.id);
    const implementationMessage = rendered.at(-1);
    assert.match(implementationMessage?.header.title.content || '', /实施者.*执行中/);
    const implementCursor = await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: implementation.id } });
    const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${late.job.nodeId}`, name: 'independent review' } });
    taskIds.push(reviewTask.id);
    const review = await run(reviewTask.id, new Date(Date.now() + 1000));
    await prisma.taskRun.update({ where: { id: review.id }, data: { status: 'running' } });
    await prisma.taskRunParticipant.create({ data: { taskRunId: review.id, gatewayNameSnapshot: 'Local', harnessType: 'codex', role: 'tester' } });
    await relayTaskGraphRunReply(review.id);
    assert.match(rendered.at(-1)?.header.title.content || '', /测试验收.*正在复核/);
    const reviewCursor = await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: review.id } });
    assert.notEqual(implementCursor.messageId, reviewCursor.messageId);
    await prisma.taskRun.update({ where: { id: implementation.id }, data: { status: 'completed', summary: '修复已提交。' } });
    assert.equal(await relayTaskGraphRunReply(implementation.id), true, 'An older run can still finalize its own card');
    assert.equal(updates.at(-1)?.id, implementCursor.messageId);
    assert.match(rendered.at(-1)?.header.title.content || '', /实施者.*本轮已结束/);
    assert.match(JSON.stringify(rendered.at(-1)?.body.elements[0]), /修复已提交/);
    assert.equal(await relayTaskGraphRunReply(implementation.id), false);
    await prisma.taskGraphNode.update({ where: { id: late.job.nodeId }, data: { status: 'passed' } });
    assert.equal(await relayTaskGraphRunReply(implementation.id), false, 'Ticket acceptance cannot rewrite a finalized reply');

    const lost = await fixture(); loseResponse = true;
    await assert.rejects(deliverGraphChildProgress(lost.task.id, 'input', '等待输入'), /accepted response lost/);
    const lostRun = await run(lost.task.id);
    const beforeLost = sends.size;
    await relayTaskGraphRunReply(lostRun.id, true);
    assert.equal(sends.size, beforeLost + 1, 'A new TaskRun has its own send identity, separate from a pre-run notice');

    const expired = await fixture(); loseResponse = true;
    await assert.rejects(deliverGraphChildProgress(expired.task.id, 'input', '等待输入'), /accepted response lost/);
    await prisma.taskGraphEvent.updateMany({ where: { runId: expired.graph.id, kind: 'notification_send_started' }, data: { createdAt: new Date(0) } });
    const expiredRun = await run(expired.task.id), beforeExpired = attempts.length;
    await prisma.taskRunFeishuRelay.create({ data: { taskRunId: expiredRun.id, bindingId: expired.binding.id, createdAt: new Date(0) } });
    await relayTaskGraphRunReply(expiredRun.id, true);
    assert.equal(attempts.length, beforeExpired + 1, 'A new run sends a new card without retrying the expired pre-run notice');
    const uncertain = await fixture(), uncertainRun = await run(uncertain.task.id); loseResponse = true;
    await assert.rejects(relayTaskGraphRunReply(uncertainRun.id, true), /accepted response lost/);
    await prisma.taskGraphEvent.updateMany({ where: { runId: uncertain.graph.id, kind: 'notification_send_started' }, data: { createdAt: new Date(0) } });
    const uncertainAttempts = attempts.length;
    await assert.rejects(relayTaskGraphRunReply(uncertainRun.id, true), /reconcile|uncertain/);
    assert.equal(attempts.length, uncertainAttempts, 'An uncertain send in the same run retains its original age and never generates a new UUID');

    const concurrent = await fixture();
    let releaseSend!: () => void, sendStarted!: () => void;
    const blockedSend = new Promise<void>(resolve => { releaseSend = resolve; });
    const enteredSend = new Promise<void>(resolve => { sendStarted = resolve; });
    onSend = async () => { sendStarted(); await blockedSend; };
    const fallback = deliverGraphChildProgress(concurrent.task.id, 'input', '等待输入');
    await enteredSend;
    const concurrentRun = await run(concurrent.task.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await Promise.race([relayTaskGraphRunReply(concurrentRun.id, true), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Concurrent delivery did not respect the binding lock')), 5000);
      })]), false, 'The fallback and TaskRun share the binding lock');
    } finally { clearTimeout(timeout); releaseSend(); await fallback; onSend = undefined; }
    const beforeConcurrent = sends.size;
    await relayTaskGraphRunReply(concurrentRun.id, true);
    assert.equal(sends.size, beforeConcurrent + 1, 'The new run creates one card after the pre-run delivery releases the shared topic lock');
    await relayTaskGraphRunReply(concurrentRun.id, true);
    assert.equal(sends.size, beforeConcurrent + 1, 'Replaying the current run does not create another card');

    const legacy = await fixture();
    const legacyIdentity = `child-progress:${legacy.task.id}:old-input`;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await postGraphChildProgress(legacy.task.id, 'old-input', '旧暂停');
    await prisma.taskGraphEvent.create({ data: { runId: legacy.graph.id, idempotencyKey: `notification-message:${digest(legacyIdentity)}`,
      kind: 'notification_message_sent', payload: { messageId: 'legacy-fallback-card' } } });
    const legacyRun = await run(legacy.task.id), beforeLegacy = sends.size;
    await relayTaskGraphRunReply(legacyRun.id, true);
    assert.equal(sends.size, beforeLegacy + 1, 'A legacy pre-run receipt does not replace the new run card');
    assert.notEqual((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: legacyRun.id } })).messageId, 'legacy-fallback-card');

    const legacyLost = await fixture();
    const oldIdentity = `child-progress:${legacyLost.task.id}:old-lost`;
    await postGraphChildProgress(legacyLost.task.id, 'old-lost', '旧超时');
    await prisma.taskGraphEvent.create({ data: { runId: legacyLost.graph.id, idempotencyKey: `notification-send:${digest(oldIdentity)}`,
      kind: 'notification_send_started', payload: { identity: oldIdentity }, createdAt: new Date(0) } });
    const legacyLostRun = await run(legacyLost.task.id), oldAttempts = attempts.length;
    await relayTaskGraphRunReply(legacyLostRun.id, true);
    assert.equal(attempts.length, oldAttempts + 1, 'The new run does not retry or adopt the uncertain legacy notice');
    assert.equal((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: { runId: legacyLost.graph.id, idempotencyKey: `notification-send:${digest(oldIdentity)}` } } })).createdAt.getTime(), 0);

    const backlog = await fixture();
    for (let index = 0; index < 100; index++) {
      const old = await run(backlog.task.id, new Date(index));
      await prisma.taskRun.update({ where: { id: old.id }, data: { completedAt: new Date() } });
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
      lastFailure: { code: 'integration_conflict', detail: JSON.stringify({ integration: { paths: ['shared.txt'] } }) },
    } } } });
    await prisma.taskGraphNode.update({ where: { id: first.job.nodeId }, data: { status: 'attention' } });
    await deliverGraphChildProgress(first.task.id, 'technical-conflict', 'shared.txt 存在技术冲突，待平台处理。');
    const technicalCard = JSON.stringify(updates.at(-1)?.card);
    assert.match(technicalCard, /shared.txt/); assert.match(technicalCard, /待处理/);
    assert.doesNotMatch(technicalCard, /需你确认/); assert.match(technicalCard, /需要你决定：否/);
    await prisma.taskGraphExecution.update({ where: { id: first.job.id }, data: { dispatchMetadata: { progress: {
      ...initialExecutionProgress(), phase: 'integrate', state: 'waiting_decision',
      lastFailure: { code: 'scope_change', detail: 'shared.txt 中两项业务规则互斥，需要业务负责人选择。',
        affectedPaths: ['shared.txt'], owner: 'user', requiresUserDecision: true,
        action: '请确认采用哪项业务规则：保留原机型范围，还是纳入新增机型。' },
    } } } });
    await deliverGraphChildProgress(first.task.id, 'business-decision', '请确认采用哪项业务规则。');
    const card = JSON.stringify(updates.at(-1)?.card);
    assert.match(card, /shared.txt/); assert.match(card, /请确认采用哪项业务规则/); assert.match(card, /待你确认/);
    assert.match(card, /负责人：你/); assert.match(card, /需要你决定：是/);
    await prisma.taskGraphExecution.update({ where: { id: first.job.id }, data: { dispatchMetadata: { progress: {
      ...initialExecutionProgress(), phase: 'check', state: 'exhausted', repairAttempts: 2,
      lastFailure: { code: 'test_failed', detail: '原检查连续失败，自动处理额度已用尽。' },
    } } } });
    await deliverGraphChildProgress(first.task.id, 'exhausted', '自动处理额度已用尽');
    assert.equal(updates.at(-1)?.id, first.binding.rootMessageId);
    assert.match(JSON.stringify(updates.at(-1)?.card), /本轮自动尝试已停止/);

    const chat = await fixture(), chatRun = await run(chat.task.id);
    const answer = '补 1 张可以。\n\n你这张是伯乐三段熔胶页，不能作为白色五段页的独立验收图。\n\n请补白色五段储料射退设定整屏照片。';
    await prisma.taskRun.update({ where: { id: chatRun.id }, data: { summary: answer } });
    await prisma.taskGraphNode.update({ where: { id: chat.job.nodeId }, data: { status: 'attention' } });
    await prisma.taskGraphExecution.update({ where: { id: chat.job.id }, data: { status: 'attention', dispatchMetadata: { progress: {
      ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: '旧材料暂停：缺少白色五段验收原图。' },
    } } } });
    await prisma.taskGraphEvent.create({ data: { runId: chat.graph.id, nodeId: chat.job.nodeId, kind: 'conversation_followup_bound',
      idempotencyKey: 'wrong-execution', payload: { taskRunId: chatRun.id, executionId: 'another-execution' } } });
    await relayTaskGraphRunReply(chatRun.id, true);
    assert.match(JSON.stringify(rendered.at(-1)?.body.elements[0]), /你这张是伯乐三段/,
      'Every run shows the Agent answer without requiring a conversation binding');
    assert.match(rendered.at(-1)?.header.title.content || '', /本轮已结束/);
    await prisma.taskGraphEvent.create({ data: { runId: chat.graph.id, nodeId: chat.job.nodeId, kind: 'conversation_followup_bound',
      idempotencyKey: 'chat-binding', payload: { taskRunId: chatRun.id, executionId: chat.job.id } } });
    const beforeChat = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: chat.job.id } });
    const cardsBefore = sends.size;
    await relayTaskGraphRunReply(chatRun.id, true);
    assert.match(JSON.stringify(rendered.at(-1)?.body.elements[0]), /你这张是伯乐三段.*请补白色五段/,
      'A persisted conversation binding puts the actual answer on the first screen, even after live binding cleanup');
    assert.doesNotMatch(rendered.at(-1)?.header.title.content || '', /需你确认/);
    assert.equal(sends.size, cardsBefore, 'The current run updates its own existing card');
    assert.equal(await relayTaskGraphRunReply(chatRun.id), false, 'A completed conversation does not resend its answer on each poll');
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: chat.job.id } }), beforeChat,
      'Rendering a conversation cannot resume the execution or alter its claim, candidate or budget');
    const overviewRoom = await prisma.liveRoom.create({ data: { title: 'Parent', sourceTaskId: first.graph.parentTaskId } });
    roomIds.push(overviewRoom.id);
    await prisma.feishuConversationBinding.create({ data: { scopeKey: `parent-${first.graph.id}`, liveRoomId: overviewRoom.id, appId: 'fixture', chatId: 'repo-group', chatType: 'group', rootMessageId: 'parent-root' } });
    assert.equal(await publishGraphOverview(first.graph.id), true);
    const rootCard = () => updates.filter(item => item.id === first.binding.rootMessageId).at(-1)?.card as ReturnType<typeof buildRunReplyCard>;
    assert.equal(rootCard().header.template, 'red', 'The topic root reflects failure even when its last TaskRun completed long ago');
    const beforeRefresh = updates.length;
    assert.equal(await publishGraphOverview(first.graph.id), false);
    assert.equal(updates.length, beforeRefresh, 'Unchanged topic roots do not produce periodic API writes');
    await prisma.taskGraphNode.update({ where: { id: first.job.nodeId }, data: { status: 'awaiting_human' } });
    await publishGraphOverview(first.graph.id);
    assert.equal(rootCard().header.template, 'yellow');
    await prisma.taskGraphNode.update({ where: { id: first.job.nodeId }, data: { status: 'passed' } });
    const savedJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.job.id } });
    await publishGraphOverview(first.graph.id);
    assert.equal(rootCard().header.template, 'green');
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.job.id } }), savedJob, 'Card refresh cannot change execution, claim or budget');
    console.log('New runs own new cards; same-run uncertain sends retain their age; 100 superseded cursors cannot starve delivery; current failure reaches the folded card');
  } finally {
    await prisma.taskGraphRun.deleteMany({ where: { id: { in: graphIds } } });
    await prisma.liveRoom.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
