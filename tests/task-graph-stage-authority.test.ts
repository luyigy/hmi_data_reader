import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { captureStageAuthority } from '../src/lib/acpx/stage-authority';
import { StageExecutionRequest } from '../src/lib/acpx/stage-execution-request';
import { applyExecutionOutcome, bindExecutionTaskRun, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { claimExecution, claimNode, createTaskGraphRun, releaseReadyNodes, recordExecutionDispatch } from '../src/lib/task-graph/store';
import type { AcpxRunRequest } from '../src/lib/acpx/types';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: 'W001 DB authority fixture' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'fixture://W001', nodes: [{ key: 'A', goal: 'fixed authority', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/w001-source',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'A', 'claim');
    const job = await claimExecution(run.id, 'A', 'repo', 'claim'); assert(job);
    await recordExecutionDispatch({ runId: run.id, nodeKey: 'A', executionKey: 'repo', claimToken: 'claim',
      dispatchMetadata: { integrationRef: 'refs/heads/w001-fixture', workspaceBase: 'a'.repeat(40) } });
    await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim', expectedRevision: 0, outcomeId: 'fixture-prepared',
      outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: 'a'.repeat(40), candidateCommit: 'a'.repeat(40) } });
    const child = await prisma.task.create({ data: { name: 'stage child' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: '/tmp/w001-source' } });
    const taskRun = await prisma.taskRun.create({ data: { taskId: child.id, status: 'running' } });
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(current.dispatchMetadata); assert(progress);
    const request: AcpxRunRequest = { taskId: child.id, taskName: 'fixed stage', orchestrationMode: 'single', participants: [],
      graphExecution: { executionId: job.id, claimToken: 'claim', revision: progress.revision, inputIds: ['material'] } };
    await prisma.$transaction(tx => bindExecutionTaskRun(tx, request.graphExecution!, taskRun.id));
    const before = await captureStageAuthority(request, taskRun.id); assert(before);
    const runtime = { workingDirectory: '/tmp/w001-source', workspaceRoot: '/tmp/w001-source',
      permissionConfig: { profile: 'custom' as const, sandboxMode: 'workspace-write' as const, networkAccess: 'restricted' as const, approvalPolicy: 'never' as const, writableRoots: [] },
      extraReadOnlyPaths: [], extraWritableRoots: [], outputDirectory: '/tmp/w001-output',
      outputBindings: JSON.stringify([{ source: '/tmp/w001-output', target: '/tmp/w001-output', readOnly: false }]) };
    const sealed = StageExecutionRequest.create({ authority: before, runtime, prompt: 'Approved implementation' });
    sealed.assertMatches({ authority: (await captureStageAuthority(request, taskRun.id))!, runtime });
    const bound = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const boundProgress = executionProgress(bound.dispatchMetadata); assert(boundProgress);
    // Simulate a competing candidate change only in this disposable schema, between prepare and launch.
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: {
      dispatchMetadata: metadataWithProgress(bound.dispatchMetadata, { ...boundProgress, candidateCommit: 'b'.repeat(40) }) } });
    const after = await captureStageAuthority(request, taskRun.id); assert(after);
    assert.throws(() => sealed.assertMatches({ authority: after, runtime }), /W001.*authority drift/);
    await assert.rejects(captureStageAuthority(request, 'different-run'), /W001.*TaskRun/);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: 'replaced-claim' } });
    await assert.rejects(captureStageAuthority(request, taskRun.id), /ownership changed/);
    console.log('W001 real ledger: fixed authority stable; candidate drift, stale TaskRun and replaced claim rejected; no outcome or budget advancement.');
  } finally {
    await prisma.task.deleteMany({ where: { name: 'stage child' } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
