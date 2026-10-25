import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { cleanupFeishuOwnedStaleTaskRuns } from '../src/lib/feishu-startup-task-cleanup';
import { exitedGraphWriter } from './fixtures/exited-graph-writer';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'startup ownership fixture' } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://startup-ownership', nodes: [{ key: 'A', goal: 'live graph', dependsOn: [], acceptance: { mode: 'automatic', checks: ['done'] }, executions: [{ key: 'repo', repository: '/fixture/repo', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
  const node = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: graph.id }, include: { executions: true } });
  const created: string[] = [];
  const run = async (name: string, metadata: unknown, session = true, status = 'running', taskId?: string) => {
    const task = await prisma.task.create({ data: { ...(taskId ? { id: taskId } : {}), name } }); created.push(task.id);
    return prisma.taskRun.create({ data: { taskId: task.id, status, controlMetadata: JSON.stringify(metadata), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', status: status === 'pending' ? 'pending' : 'running', controlMetadata: JSON.stringify(session ? { codexThreadId: 'fixture-thread' } : {}) } } }, include: { participants: true } });
  };
  try {
    const liveWriter = await createGraphWriter();
    const marker = await run('live ordinary writer', { graphWriter: liveWriter });
    const finalizing = await run('live supervisor finalizing after harness release', { graphWriter: liveWriter, graphWriterReleased: { nonce: liveWriter.nonce, at: new Date().toISOString() } });
    const linked = await run('legacy linked graph', {});
    await prisma.taskGraphExecution.update({ where: { id: node.executions[0].id }, data: { childTaskId: linked.taskId, taskRunId: linked.id } });
    const review = await run('legacy graph review', {}, true, 'running', `task-graph-review-${node.id}`);
    const reviewMetadata = await run('durable graph review', { graphReview: { runId: graph.id, nodeId: node.id, phase: 'architecture', claimKey: 'fixture' } });
    const activeLocal = await run('known live native process', { activeLocalHarnessPid: process.pid });
    const pending = await run('pending work', {}, false, 'pending');
    const legacySession = await run('unowned stale continuation', {});
    const legacyNoSession = await run('unowned stale no session', {}, false);
    const exitedWriter = await exitedGraphWriter();
    await prisma.taskRun.update({ where: { id: linked.id }, data: { controlMetadata: JSON.stringify({ graphWriter: exitedWriter }) } });
    const chat = await run('ordinary chat interrupted during restart', { graphWriter: exitedWriter });
    const session = await prisma.taskSession.create({ data: { taskId: chat.taskId, activeRunId: chat.id } });
    await prisma.taskRun.update({ where: { id: chat.id }, data: { taskSessionId: session.id } });
    await prisma.taskRunParticipant.updateMany({ where: { taskRunId: chat.id }, data: { status: 'completed', completedAt: new Date(), summary: 'answer saved before restart' } });
    const unknown = await run('unknown writer host', { graphWriter: { ...exitedWriter, hostname: 'different-host' } });
    const conversation = await run('graph conversation', { graphWriter: exitedWriter, graphConversation: { executionId: node.executions[0].id } });
    for (let attempt = 0; attempt < 2; attempt++) await cleanupFeishuOwnedStaleTaskRuns();
    for (const current of [marker, finalizing, linked, review, reviewMetadata, activeLocal, unknown, conversation]) {
      const actual = await prisma.taskRun.findUniqueOrThrow({ where: { id: current.id }, include: { participants: true } });
      assert.equal(actual.status, 'running', `${current.taskId} belongs to another live owner`);
      assert.equal(actual.completedAt, null); assert.equal(actual.participants[0].status, 'running'); assert.equal(actual.participants[0].completedAt, null);
    }
    const recovered = await prisma.taskRun.findUniqueOrThrow({ where: { id: chat.id }, include: { participants: true } });
    assert.equal(recovered.status, 'interrupted', 'Exited ordinary chat must stop blocking the original session');
    assert.ok(recovered.completedAt);
    assert.equal(recovered.participants[0].status, 'completed', 'Keep the native participant result');
    assert.equal(recovered.participants[0].summary, 'answer saved before restart');
    assert.equal((await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } })).activeRunId, null);
    assert.equal(await prisma.taskRun.count({ where: { taskSessionId: session.id, status: { in: ['pending', 'running', 'waiting_for_input'] } } }), 0, 'The runner admission guard must allow the next message');
    const next = await executeAcpxTaskRun({ taskId: chat.taskId, taskSessionId: session.id, taskName: 'same session after restart', orchestrationMode: 'single', participants: [] });
    assert.equal(next.status, 'completed', 'The real runner accepts a new turn in the original session without a model or external writes');
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: next.taskRunId } })).taskSessionId, session.id);
    const pendingAfter = await prisma.taskRun.findUniqueOrThrow({ where: { id: pending.id }, include: { participants: true } });
    assert.equal(pendingAfter.status, 'pending'); assert.equal(pendingAfter.participants[0].status, 'pending');
    for (const [current, expectedParticipant] of [[legacySession, 'completed'], [legacyNoSession, 'failed']] as const) {
      const actual = await prisma.taskRun.findUniqueOrThrow({ where: { id: current.id }, include: { participants: true } });
      assert.equal(actual.status, 'completed'); assert.equal(actual.participants[0].status, expectedParticipant);
    }
    console.log('Feishu startup preserves graph writers, legacy graph bindings, review owners, live native processes and pending work; unowned stale continuation cleanup remains idempotent');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.deleteMany({ where: { id: { in: [...created, parent.id] } } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
