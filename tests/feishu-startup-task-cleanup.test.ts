import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { cleanupFeishuOwnedStaleTaskRuns } from '../src/lib/feishu-startup-task-cleanup';

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
    const marker = await run('durable graph writer', { graphWriter: await createGraphWriter() });
    const linked = await run('legacy linked graph', {});
    await prisma.taskGraphExecution.update({ where: { id: node.executions[0].id }, data: { childTaskId: linked.taskId, taskRunId: linked.id } });
    const review = await run('legacy graph review', {}, true, 'running', `task-graph-review-${node.id}`);
    const reviewMetadata = await run('durable graph review', { graphReview: { runId: graph.id, nodeId: node.id, phase: 'architecture', claimKey: 'fixture' } });
    const activeLocal = await run('known live native process', { activeLocalHarnessPid: process.pid });
    const pending = await run('pending work', {}, false, 'pending');
    const legacySession = await run('unowned stale continuation', {});
    const legacyNoSession = await run('unowned stale no session', {}, false);
    for (let attempt = 0; attempt < 2; attempt++) await cleanupFeishuOwnedStaleTaskRuns();
    for (const current of [marker, linked, review, reviewMetadata, activeLocal]) {
      const actual = await prisma.taskRun.findUniqueOrThrow({ where: { id: current.id }, include: { participants: true } });
      assert.equal(actual.status, 'running', `${current.taskId} belongs to another live owner`);
      assert.equal(actual.completedAt, null); assert.equal(actual.participants[0].status, 'running'); assert.equal(actual.participants[0].completedAt, null);
    }
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
