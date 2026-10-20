import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { initialExecutionProgress, metadataWithProgress, executionProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage } from '../src/lib/task-graph/conversation-inbox';
import { reserveConversationFollowup } from '../src/lib/task-graph/conversation-followup';

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
    const noReservation = async () => assert.equal(await reserveConversationFollowup(node.id), null);
    for (const mutation of [
      { claimToken: 'new-owner' },
      { commit: 'b'.repeat(40) },
      { dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), revision: 8, phase: 'acceptance' }) },
    ]) {
      phase.observeExecutionWriter = async (...args: Parameters<typeof observe>) => {
        const result = await observe(...args);
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: mutation });
        return result;
      };
      await noReservation();
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: job.claimToken, commit: job.commit, dispatchMetadata: job.dispatchMetadata! } });
    }
    const taskWriter = await createGraphWriter();
    const modelRun = await prisma.taskRun.create({ data: { taskId: child.id, status: 'completed', mode: 'acpx',
      controlMetadata: JSON.stringify({ graphWriter: taskWriter, graphWriterReleased: { nonce: taskWriter.nonce, at: new Date().toISOString() } }),
      participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', status: 'completed' } } } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: modelRun.id } });
    phase.observeExecutionWriter = async (...args: Parameters<typeof observe>) => {
      const result = await observe(...args);
      await prisma.taskRun.update({ where: { id: modelRun.id }, data: { controlMetadata: JSON.stringify({ graphWriter: await createGraphWriter() }) } });
      return result;
    };
    await noReservation();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: null } });
    await prisma.taskRun.delete({ where: { id: modelRun.id } });
    phase.observeExecutionWriter = observe;
    const originalProgress = executionProgress(job.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress({}, { ...originalProgress, workerReleasedAt: undefined }) } });
    await noReservation();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress({}, { ...originalProgress, worker: { ...originalProgress.worker!, hostname: 'unobservable-host' } }) } });
    await noReservation();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: job.dispatchMetadata! } });
    phase.observeExecutionWriter = async (...args: Parameters<typeof observe>) => {
      await new Promise(resolve => setTimeout(resolve, 5200));
      return observe(...args);
    };
    const startedAt = performance.now();
    const reservations = await Promise.all([reserveConversationFollowup(node.id), reserveConversationFollowup(node.id)]);
    assert.equal(reservations.filter(Boolean).length, 1, 'Slow competing readers may create only one reservation');
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.claimToken, job.claimToken); assert.equal(after.commit, job.commit);
    assert.equal(executionProgress(after.dispatchMetadata)!.revision, originalProgress.revision + 1);
    assert.equal(executionProgress(after.dispatchMetadata)!.platformAttempts, 0);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 1);
    console.log(`Slow writer observations outside transactions reserve once in ${Math.round(performance.now() - startedAt)}ms; stale claim/revision/candidate and live/unknown writers are refused.`);
  } finally {
    phase.observeExecutionWriter = observe;
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
