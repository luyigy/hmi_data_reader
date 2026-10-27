import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { conversationReplyIdentity } from '../src/lib/task-graph/conversation-reply-identity';
import { bindExecutionTaskRun, initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { relayTaskGraphRunReply } from '../src/lib/task-graph/run-reply-relay';

export async function conversationHandoffReplyRegression(taskId: string, nodeId: string,
  sent: { card: unknown }[], updates: { id: string; card: unknown }[]) {
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId } });
  const session = await prisma.taskSession.create({ data: { taskId } });
  const participant = { gatewayId: 'platform-local', gatewayNameSnapshot: 'local', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer',
    summary: '我会继续修改。\n\nTASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["continue-input"],"note":"用户要求继续修改"}' };
  const reservation = await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'conversation_followup_reserved',
    idempotencyKey: `handoff-reply:${session.id}`, payload: { executionId: job.id, inputIds: ['continue-input'] } } });
  const conversation = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, status: 'completed',
    createdAt: new Date(Date.now() + 20_000), participants: { create: participant },
    controlMetadata: JSON.stringify({ graphConversation: { executionId: job.id, reservationId: reservation.id, inputIds: ['continue-input'] } }) } });
  await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'conversation_followup_bound',
    idempotencyKey: `conversation-followup:${reservation.id}:run`, payload: { executionId: job.id, taskRunId: conversation.id } } });
  await prisma.taskRun.update({ where: { id: conversation.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(conversation.controlMetadata!), graphReplyIdentity: conversationReplyIdentity(job.id, 'continue-input') }) } });
  const baseline = sent.length;
  await relayTaskGraphRunReply(conversation.id);
  assert.equal(sent.length, baseline + 1);
  const card = await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: conversation.id } });
  assert.match(JSON.stringify(sent.at(-1)?.card), /执行完成/, 'Historical control text cannot create a new continuing state');
  assert.doesNotMatch(JSON.stringify(sent.at(-1)?.card), /用户要求继续修改/, 'Internal action notes must not duplicate the agent answer');
  await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'conversation_followup_finished',
    idempotencyKey: `conversation-followup:${reservation.id}:finished`, payload: {} } });
  for (let attempt = 0; attempt < 3; attempt++) {
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'claimed', claimToken: `handoff-${attempt}`, taskRunId: null,
      dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', replyEpoch: `conversation-material-handoff:${reservation.id}`, platformAttempts: attempt } } } });
    if (attempt === 0) {
      await relayTaskGraphRunReply(conversation.id, true);
      assert.match(JSON.stringify(updates.at(-1)?.card), /执行完成/, 'Historical handoff text has no runtime side effect');
    }
    const implementation = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, status: attempt < 2 ? 'failed' : 'running',
      createdAt: new Date(Date.now() + 30_000 + attempt), participants: { create: { ...participant, summary: null } } } });
    await prisma.$transaction(tx => bindExecutionTaskRun(tx, { executionId: job.id, claimToken: `handoff-${attempt}`, revision: 0 }, implementation.id));
    await relayTaskGraphRunReply(implementation.id);
    assert.equal(sent.length, baseline + 2, 'Normal execution retries share their own reply, separate from historical acknowledgement');
    assert.notEqual((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: implementation.id } })).messageId, card.messageId);
    const count = updates.length;
    await relayTaskGraphRunReply(conversation.id, true);
    assert.ok(updates.slice(count).every(update => update.id === card.messageId), 'Historical reply may update only its own card');
    if (attempt === 2) {
      await prisma.taskRunParticipant.updateMany({ where: { taskRunId: implementation.id }, data: { summary: '已修改，6 项测试通过。' } });
      await prisma.taskRun.update({ where: { id: implementation.id }, data: { status: 'completed' } });
      await relayTaskGraphRunReply(implementation.id);
      assert.match(JSON.stringify(updates.at(-1)?.card), /已修改，6 项测试通过/);
    }
  }
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'claimed', claimToken: 'wrong-session', taskRunId: null,
    dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', replyEpoch: `conversation-material-handoff:${reservation.id}` } } } });
  const otherSession = await prisma.taskSession.create({ data: { taskId } });
  const wrong = await prisma.taskRun.create({ data: { taskId, taskSessionId: otherSession.id, status: 'running', participants: { create: participant } } });
  await prisma.$transaction(tx => bindExecutionTaskRun(tx, { executionId: job.id, claimToken: 'wrong-session', revision: 0 }, wrong.id));
  assert.notEqual(JSON.parse((await prisma.taskRun.findUniqueOrThrow({ where: { id: wrong.id } })).controlMetadata!).graphReplyIdentity, JSON.parse((await prisma.taskRun.findUniqueOrThrow({ where: { id: conversation.id } })).controlMetadata!).graphReplyIdentity, 'Different sessions cannot inherit historical reply identity');
  const declined = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, status: 'completed',
    createdAt: new Date(Date.now() + 35_000), participants: { create: participant },
    controlMetadata: JSON.stringify({ graphConversation: { executionId: job.id, reservationId: 'declined', inputIds: ['declined'] } }) } });
  await prisma.taskRun.update({ where: { id: declined.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(declined.controlMetadata!), graphReplyIdentity: conversationReplyIdentity(job.id, 'declined') }) } });
  await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'conversation_followup_finished',
    idempotencyKey: 'conversation-followup:declined:finished', payload: {} } });
  await relayTaskGraphRunReply(declined.id);
  assert.doesNotMatch(JSON.stringify(sent.at(-1)?.card), /正在继续/, 'Declined handoff must not pretend execution is continuing');
  const question = await prisma.taskRun.create({ data: { taskId, taskSessionId: session.id, status: 'completed',
    createdAt: new Date(Date.now() + 40_000), participants: { create: { ...participant, summary: '刚才的修改修复了定位边界。' } },
    controlMetadata: JSON.stringify({ graphConversation: { executionId: job.id, reservationId: 'next-question', inputIds: ['next-question'] } }) } });
  await prisma.taskRun.update({ where: { id: question.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(question.controlMetadata!), graphReplyIdentity: conversationReplyIdentity(job.id, 'next-question') }) } });
  await relayTaskGraphRunReply(question.id);
  assert.equal(sent.length, baseline + 4, 'An independent later question keeps a new answer');
  console.log('PASS historical handoff is inert; normal execution retries share a card; later questions and other sessions remain separate');
}
