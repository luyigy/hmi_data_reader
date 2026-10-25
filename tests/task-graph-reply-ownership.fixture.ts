import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { bindExecutionTaskRun, initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { bindGraphReviewTaskRun } from '../src/lib/task-graph/review-ownership';
import { relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';
import { receiveGraphTaskMessage, registerConversationSteering, deliverConversationSteering } from '../src/lib/task-graph/conversation-inbox';
import { resolveConversationTarget } from '../src/lib/task-graph/conversation-target';

export async function replyOwnershipRegression(taskId: string, nodeId: string,
  sent: unknown[], updates: { id: string; card: unknown }[]) {
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId } });
  const session = await prisma.taskSession.create({ data: { taskId } });
  const participant = { gatewayId: 'platform-local', gatewayNameSnapshot: 'local', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', runner: 'codex',
    controlMetadata: JSON.stringify({ lastSessionId: 'ownership-native', lastSessionKind: 'codex_thread' }) };
  const baseline = sent.length;
  const runs: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: null, status: 'claimed', claimToken: `attempt-${attempt}`,
      dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', platformAttempts: attempt } } } });
    const run = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, createdAt: new Date(Date.now() + 5000 + attempt), status: attempt < 3 ? 'failed' : 'running', participants: { create: participant } } });
    await prisma.$transaction(tx => bindExecutionTaskRun(tx, { executionId: job.id, claimToken: `attempt-${attempt}`, revision: 0 }, run.id));
    runs.push(run.id); await relayTaskGraphRunReply(run.id);
    assert.equal(sent.length, baseline + 1, 'Three automatic startup failures and success retain one phase card');
  }
  const latest = runs.at(-1)!;
  const firstCard = (await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: latest } })).messageId;
  const updateCount = updates.length;
  await relayTaskGraphRunReply(runs[0], true); assert.equal(updates.length, updateCount, 'Old phase attempts cannot overwrite a newer attempt');
  await prisma.taskSession.update({ where: { id: session.id }, data: { activeRunId: latest } });
  const detach = registerConversationSteering(job.id, latest, async () => 'accepted');
  try {
    for (const sourceId of ['steer-one', 'steer-two']) await receiveGraphTaskMessage({ taskId, sourceId, actorId: 'user', content: sourceId });
    await deliverConversationSteering(); await relayTaskGraphRunReply(latest);
    assert.equal(sent.length, baseline + 1, 'Messages arriving during one native turn share its existing card');
    await relayTaskGraphRunReply(latest); assert.equal(sent.length, baseline + 1);
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: latest }, data: { summary: '回答两条补充消息' } });
    await prisma.taskRun.update({ where: { id: latest }, data: { status: 'completed' } });
    await relayTaskGraphRunReply(latest);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId, kind: 'conversation_reply_card' } }), 0, 'Steering needs no per-source card ledger');
    assert(updates.some(update => update.id === firstCard && JSON.stringify(update.card).includes('回答两条补充消息')));
    const updatedJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const target = await prisma.$transaction(tx => resolveConversationTarget(tx, updatedJob, JSON.stringify({ feishuParentMessageId: firstCard })));
    assert.equal(target.kind, 'session'); if (target.kind === 'session') assert.equal(target.taskRunId, latest);
  } finally { detach(); }
  await prisma.taskRunEvent.create({ data: { taskRunId: latest, sequence: 1, eventType: 'control_message', content: '工具执行失败，退出码 2', metadata: JSON.stringify({ kind: 'tool', status: 'failed', exitCode: 2 }) } });
  await relayTaskGraphRunReply(latest);
  assert.match(JSON.stringify(updates.at(-1)?.card), /工具失败记录/);
  assert.doesNotMatch(JSON.stringify(updates.at(-1)?.card), /正式验收未通过/);
  const reviewTask = await prisma.task.create({ data: { id: `task-graph-review-${nodeId}`, name: 'review ownership' } });
  try {
    const reviewSession = await prisma.taskSession.create({ data: { taskId: reviewTask.id } });
    const reviewBaseline = sent.length;
    await prisma.taskGraphNode.update({ where: { id: nodeId }, data: { status: 'verifying' } });
    for (let attempt = 0; attempt < 4; attempt++) {
      const claimKey = `test-review-${attempt}`;
      await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'review_claimed', idempotencyKey: claimKey, payload: {} } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit: 'b'.repeat(40), dispatchMetadata: { progress: {
        ...initialExecutionProgress(), phase: 'acceptance', platformAttempts: attempt, review: { kind: 'ready', phase: 'acceptance', candidateCommit: 'b'.repeat(40), claimKey } } } } });
      const run = await prisma.taskRun.create({ data: { taskId: reviewTask.id, taskSessionId: reviewSession.id, status: attempt < 3 ? 'failed' : 'completed',
        createdAt: new Date(Date.now() + 10000 + attempt), participants: { create: { ...participant, role: 'tester' } } } });
      await prisma.$transaction(tx => bindGraphReviewTaskRun(tx, { runId: node.runId, nodeId, phase: 'acceptance', claimKey }, run.id));
      await relayTaskGraphRunReply(run.id); assert.equal(sent.length, reviewBaseline + 1, 'Formal reviewer retries retain their own phase card');
    }
    assert.notEqual(updates.at(-1)?.id, firstCard, 'Reviewer and implementer cards remain separate');
  } finally { await prisma.task.delete({ where: { id: reviewTask.id } }); }
  console.log('PASS stable implementation/review phase cards, steering on the current turn card and original reply target');
}
