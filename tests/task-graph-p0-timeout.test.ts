import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage } from '../src/lib/task-graph/conversation-inbox';
import { startConversationFollowups } from '../src/lib/task-graph/conversation-followup';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const require = createRequire(__filename);
  const phase = require('../src/lib/task-graph/phase-worker');
  const notices = require('../src/lib/task-graph/feishu');
  const observe = phase.observeExecutionWriter;
  notices.postGraphChildProgress = async () => {};
  const parent = await prisma.task.create({ data: { name: 'S01 isolated diagnostic' } });
  const child = await prisma.task.create({ data: { name: 'S01 conversation child' } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://s01-diagnostic', nodes: [{ key: 'DONE', goal: 'fixed delivery', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'app', repository: process.cwd(), gitRef: 'refs/heads/oss-prep',
        baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'approved fixture' }] }] } });
  try {
    const node = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: graph.id }, include: { executions: true } });
    const job = await prisma.taskGraphExecution.update({ where: { id: node.executions[0].id }, data: {
      status: 'integrated', childTaskId: child.id, commit: 'a'.repeat(40), claimToken: 'diagnostic-claim',
      dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), revision: 7, phase: 'acceptance',
        candidateCommit: 'a'.repeat(40), worker: await createGraphWriter(), workerReleasedAt: new Date().toISOString() }) } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'delivered_unverified' } });
    await receiveGraphTaskMessage({ taskId: child.id, sourceId: 'question', actorId: 'fixture', content: '进度如何？' });
    phase.observeExecutionWriter = async (...args: Parameters<typeof observe>) => {
      await new Promise(resolve => setTimeout(resolve, 5200));
      return observe(...args);
    };
    const started = await startConversationFollowups(1);
    assert.equal(started.length, 1, 'A slow writer observation must not expire the reservation transaction');
    await Promise.all(started.map(turn => turn.promise));
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.claimToken, job.claimToken); assert.equal(after.commit, job.commit);
    assert.equal(after.status, job.status);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 1);
    console.log('Published followup entry reserves once after a real writer observation delayed beyond 5000ms; claim and candidate retained.');
  } finally {
    phase.observeExecutionWriter = observe;
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
