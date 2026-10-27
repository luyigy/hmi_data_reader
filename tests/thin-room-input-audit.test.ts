import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { auditGraphConversationInputs } from '../src/lib/task-graph/conversation-input-audit';
import { receiveGraphRoomMessage, conversationReceiptKey, conversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'input migration audit' } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, requestKey: parent.id, version: 1, definition: {
    specRef: 'test://input-audit', nodes: [{ key: 'A', goal: 'audit', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
      executions: [{ key: 'repo', repository: process.cwd(), gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'audit',
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } }] }] } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const child = await prisma.task.create({ data: { name: 'input source' } });
  const writer = await createGraphWriter();
  const progress = { ...initialExecutionProgress(), worker: writer, workerReleasedAt: new Date().toISOString() };
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, dispatchMetadata: { progress } } });
  const room = await prisma.liveRoom.create({ data: { title: 'input audit', sourceTaskId: child.id } });
  const sender = await prisma.liveRoomMember.create({ data: { roomId: room.id, memberType: 'user', displayName: 'owner', role: 'custom' } });
  try {
    const input = async (name: string) => {
      const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, senderMemberId: sender.id, messageType: 'user', content: name } });
      await receiveGraphRoomMessage(room.id, message.id);
      return { message, event: await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: graph.id, kind: 'conversation_input', payload: { path: ['roomMessageId'], equals: message.id } } }) };
    };
    const receipt = (inputId: string, kind: string, suffix: string, extra = {}) => prisma.taskGraphEvent.create({ data: {
      runId: graph.id, nodeId: job.nodeId, kind, idempotencyKey: conversationReceiptKey(inputId) + suffix, payload: { inputId, executionId: job.id, ...extra } } });
    const untouched = await input('never delivered');
    const completed = await input('already answered');
    await receipt(completed.event.id, 'conversation_delivery_completed', ':settled');
    const bound = await input('bound but no conclusion');
    await receipt(bound.event.id, 'conversation_input_bound', '');
    const uncertain = await input('unknown steering');
    await receipt(uncertain.event.id, 'conversation_steering_started', ':steering');
    const recovered = await input('unknown old result');
    await receipt(recovered.event.id, 'conversation_delivery_uncertain', ':settled');
    const rejected = await input('rejected steering');
    await receipt(rejected.event.id, 'conversation_steering_started', ':steering');
    await receipt(rejected.event.id, 'conversation_steering_result', ':steering:result', { result: 'rejected' });
    const normal = await input('normal delivery owns it');
    await prisma.liveRoomDelivery.create({ data: { roomMessageId: normal.message.id, targetMemberId: sender.id, deliveryStatus: 'failed' } });
    await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: job.nodeId, kind: 'conversation_input', idempotencyKey: 'old-uncertain-recovery', payload: { ...(recovered.event.payload as object), rootInputId: recovered.event.id, receivedState: 'delivery_uncertain' } } });
    assert.ok(!(await conversationInputs(job.id)).some(input => input.receivedState === 'delivery_uncertain'), 'Historical uncertainty is excluded from automatic input binding');
    const before = await prisma.taskGraphEvent.count({ where: { runId: graph.id } });
    const rows = await auditGraphConversationInputs(graph.id);
    const disposition = (id: string) => rows.find(row => row.inputId === id)!.disposition;
    assert.equal(disposition(untouched.event.id), 'eligible');
    assert.equal(disposition(completed.event.id), 'completed');
    assert.equal(disposition(bound.event.id), 'assigned');
    assert.equal(disposition(uncertain.event.id), 'assigned');
    assert.equal(disposition(recovered.event.id), 'uncertain');
    assert.equal(disposition(rejected.event.id), 'eligible');
    assert.equal(disposition(normal.event.id), 'normal_delivery', 'Failed delivery does not imply it is safe to replay');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: { progress: { ...progress, workerReleasedAt: undefined } } } });
    assert.equal((await auditGraphConversationInputs(graph.id)).find(row => row.inputId === untouched.event.id)!.disposition, 'writer_not_exited');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: { progress: { ...progress, worker: { ...writer, hostname: 'unobservable-host' } } } } });
    assert.equal((await auditGraphConversationInputs(graph.id)).find(row => row.inputId === untouched.event.id)!.disposition, 'writer_not_exited');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id } }), before, 'Repeated audits do not consume or mutate historical input');
    assert.equal(await prisma.taskRun.count({ where: { taskId: child.id } }), 0);
    console.log('Legacy input audit: completed, bound, unknown, rejected steering, existing normal delivery and live/unknown writers preserved; zero replay');
  } finally {
    await prisma.liveRoom.delete({ where: { id: room.id } }); await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
