import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { bindGraphReviewTaskRun, graphReviewClaimKey, completedGraphReviewTaskRun, assertGraphReviewOwnership } from '../src/lib/task-graph/review-ownership';
import { recoverGraphReview } from '../src/lib/task-graph/restart-recovery';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const writer = await createGraphWriter();
  const departed = { ...writer, supervisor: { ...writer.supervisor, pid: 2147483647 } };
  for (const phase of ['architecture', 'acceptance'] as const) {
    const parent = await prisma.task.create({ data: { name: `${phase} restart` } });
    const commit = 'a'.repeat(40);
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: randomUUID(), definition: { specRef: 'fixture://review-restart', nodes: [{
      key: 'N', goal: 'verify', dependsOn: [], acceptance: { mode: 'automatic', checks: ['check'] }, executions: ['reader', 'model'].map(key => ({
        key, repository: `/fixture/${key}`, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture',
      })),
    }] } });
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } }, include: { executions: true } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
    for (const job of node.executions) await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, claimToken: job.id,
      dispatchMetadata: metadataWithProgress({}, { ...initialExecutionProgress(), phase, candidateCommit: commit, workspaceBase: commit }) } });
    const claimKey = `${phase}:repair:first`;
    const eventKind = phase === 'architecture' ? 'architecture_claimed' : 'review_claimed';
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: eventKind, idempotencyKey: claimKey, payload: {} } });
    const task = await prisma.task.create({ data: { id: `task-graph-${phase === 'architecture' ? 'architecture' : 'review'}-${node.id}`, name: phase } });
    const createReview = async (key: string, owner: typeof writer) => prisma.$transaction(async tx => {
      const result = await tx.taskRun.create({ data: { taskId: task.id, status: 'completed', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: owner }),
        participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'tester', status: 'completed' } } } });
      await bindGraphReviewTaskRun(tx, { runId: run.id, nodeId: node.id, phase, claimKey: key }, result.id); return result;
    });
    const oldRun = await createReview(claimKey, writer);
    assert.equal(await recoverGraphReview(node.id), 'waiting', 'A terminal TaskRun does not prove its writer exited');
    assert.equal(await completedGraphReviewTaskRun(node.id, phase, claimKey), null);
    await prisma.taskRun.update({ where: { id: oldRun.id }, data: { status: 'running', controlMetadata: JSON.stringify({ graphWriter: departed }) } });
    assert.equal(await recoverGraphReview(node.id), 'ready');
    const replacement = await graphReviewClaimKey(node.id, phase, 'initial');
    assert.notEqual(replacement, claimKey);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, idempotencyKey: claimKey } }), 1, 'Historical claim is retained');
    await assert.rejects(assertGraphReviewOwnership(node.id, phase, claimKey, oldRun.id), /ownership changed/);
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: eventKind, idempotencyKey: replacement, payload: {} } });
    const replacementRun = await createReview(replacement, departed);
    assert.equal(await completedGraphReviewTaskRun(node.id, phase, replacement), replacementRun.id);
    assert.equal(await graphReviewClaimKey(node.id, phase, 'initial'), replacement, 'Saved repaired review keeps its exact noninitial key');
    for (const job of await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } })) {
      const progress = executionProgress(job.dispatchMetadata); assert(progress);
      assert.equal(progress.platformAttempts, 1); assert.equal(progress.review?.candidateCommit, commit);
    }
    await prisma.taskGraphExecution.update({ where: { id: node.executions[0].id }, data: { commit: 'b'.repeat(40) } });
    assert.equal(await graphReviewClaimKey(node.id, phase, 'new-combination'), 'new-combination', 'Reader-only repair starts a fresh combination while model retains old evidence');
    assert.equal(await completedGraphReviewTaskRun(node.id, phase, replacement), null);
    assert.equal(await recoverGraphReview(node.id), 'none', 'Old sibling review must not strand a new commit combination');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'passed' } });
    await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'completed' } });
  }
  console.log('Architecture/acceptance restart preserves claims, waits for actual writer exit, fences old results and consumes exact saved review generations');
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
