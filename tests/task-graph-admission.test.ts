import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { admitNode } from '../src/lib/task-graph/preparation-recovery';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'admission-boundary-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  await writeFile(path.join(root, 'base'), 'base'); git('add', 'base'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const parent = await prisma.task.create({ data: { name: 'admission boundary' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://admission', nodes: [{
    key: 'MULTI', goal: 'independent saved work', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
    executions: ['WAIT', 'WORK'].map(key => ({ key, repository: root, gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', instructions: key })) }] } });
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'MULTI', 'node-claim');
    for (const key of ['WAIT', 'WORK']) {
      await prisma.taskGraphNode.update({ where: { runId_key: { runId: run.id, key: 'MULTI' } }, data: { status: 'claimed' } });
      const job = await claimExecution(run.id, 'MULTI', key, key); assert(job);
      const workspace = path.join(root, key); git('worktree', 'add', '--detach', workspace, baseline);
      const child = await prisma.task.create({ data: { name: key } });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: workspace, worktreeBranch: 'refs/heads/' + key } });
      const worker = await createGraphWriter();
      const p = await applyExecutionOutcome({ executionId: job.id, claimToken: key, expectedRevision: 0, outcomeId: 'saved',
        outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: baseline, workspaceBase: baseline, worker } });
      await applyExecutionOutcome({ executionId: job.id, claimToken: key, expectedRevision: p.revision, outcomeId: 'wait',
        outcome: { kind: 'decision_required', failure: { code: key === 'WAIT' ? 'permission_required' : 'dispatch_failed', detail: key } } });
      await releaseGraphExecutionWorker(job.id, key, worker.nonce);
    }
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'MULTI' } } });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id, key: 'WORK' } });
    const p = executionProgress(job.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...p, state: 'exhausted', platformAttempts: 77, lastFailure: { code: 'dispatch_failed', detail: 'legacy record without owner' } }) } });
    const runtime: typeof import('../src/lib/task-graph/runtime-preflight') = createRequire(__filename)('../src/lib/task-graph/runtime-preflight');
    const prepare = runtime.prepareDeclaredRuntime;
    let fail = true;
    runtime.prepareDeclaredRuntime = async args => { if (fail) { fail = false; throw Object.assign(new Error('temporary transaction closed'), { code: 'P2028' }); } return prepare(args); };
    try {
      const first = await admitNode(node.id, { source: 'conditions', id: 'same-durable-request', executionIds: [job.id] });
      assert.equal(first.kind, 'deferred');
      assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_admitted' } }), 0);
    } finally { runtime.prepareDeclaredRuntime = prepare; }
    // The request is retried without clearing counters; a sibling's human wait does not become an implicit dependency.
    const results = await Promise.all([admitNode(node.id, { source: 'conditions', id: 'coordinator-1', executionIds: [job.id] }),
      admitNode(node.id, { source: 'conditions', id: 'coordinator-2', executionIds: [job.id] })]);
    assert.equal(results.filter(result => result.kind === 'admitted').length, 1);
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(current.status, 'ready'); assert.equal(executionProgress(current.dispatchMetadata)?.platformAttempts, 77);
    assert.equal((await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id, key: 'WAIT' } })).status, 'attention');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_admitted' } }), 1);
    const sibling = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id, key: 'WAIT' } });
    const activeWriter = await createGraphWriter();
    const active = executionProgress(sibling.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: sibling.id }, data: { status: 'claimed', dispatchMetadata: metadataWithProgress(sibling.dispatchMetadata,
      { ...active, state: 'active', worker: activeWriter, workerReleasedAt: undefined }) } });
    const nextWriter = await createGraphWriter();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention', claimToken: 'WORK', dispatchMetadata: metadataWithProgress(current.dispatchMetadata,
      { ...executionProgress(current.dispatchMetadata)!, state: 'waiting_decision', worker: nextWriter, workerReleasedAt: undefined }) } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'claimed', claimToken: 'active-node-claim' } });
    await releaseGraphExecutionWorker(job.id, 'WORK', nextWriter.nonce);
    const continued = await admitNode(node.id, { source: 'operator', id: 'authorized-next-round' });
    assert.equal(continued.kind, 'admitted', JSON.stringify(continued));
    const aggregate = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(aggregate.status, 'claimed'); assert.equal(aggregate.claimToken, 'active-node-claim');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'claimed');
    await releaseGraphExecutionWorker(sibling.id, 'WAIT', activeWriter.nonce);
    console.log('Admission: missing owner/exhausted does not revoke work; temporary failure does not consume a request; concurrent admissions select one; independent sibling permission wait remains blocked; count 77 retained');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
