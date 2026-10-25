import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, submitNodeVerification } from '../src/lib/task-graph/store';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { executionProgress, initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';

async function scenario(phase: 'acceptance' | 'architecture') {
  const parent = await prisma.task.create({ data: { name: `publication ${phase}` } });
  const commit = 'a'.repeat(40), claimKey = `review:${phase}`;
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id,
    definition: { specRef: 'fixture://publication', nodes: [{ key: 'REVIEW', goal: 'publish failed review', dependsOn: [],
      acceptance: { mode: 'agent', reviewerId: 'local:codex', checks: ['file'], reviewLaunchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'tester' } } }, executions: [{ key: 'repo',
        repository: process.cwd(), gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: graph.id, key: 'REVIEW' } }, include: { executions: true } });
  const writer = await createGraphWriter();
  const turn = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'failed', controlMetadata: JSON.stringify({ graphWriter: writer }),
    participants: { create: { executionBackend: 'platform_local', gatewayNameSnapshot: 'local', harnessType: 'codex', role: 'tester', status: 'failed' } } } });
  const job = node.executions[0];
  const reset = async (platformAttempts = 0) => {
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, claimToken: 'implementation-claim',
      dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...initialExecutionProgress(), phase, revision: 7, platformAttempts,
        candidateCommit: commit, workspaceBase: commit, review: { kind: 'running', phase, claimKey, taskRunId: turn.id, candidateCommit: commit } }) } });
  };
  const request = { runId: graph.id, nodeKey: 'REVIEW', actorId: 'local:codex',
    evidence: { checks: [{ name: 'file', passed: false, evidence: 'review environment unavailable' }], summary: 'failed review' },
    review: { phase, claimKey, taskRunId: turn.id, outcome: 'platform_failure' as const } };
  const publish = (beforeTransaction?: () => Promise<void>) => submitNodeVerification(request, beforeTransaction ? new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') return async (...args: unknown[]) => {
        await beforeTransaction();
        return Reflect.apply(target.$transaction, target, args);
      };
      return Reflect.get(target, property, receiver);
    },
  }) : prisma);
  const unchanged = async (action: () => Promise<unknown>, pattern: RegExp) => {
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const events = await prisma.taskGraphEvent.count({ where: { nodeId: node.id } });
    await assert.rejects(action, pattern);
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), before);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id } }), events);
  };
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  try {
    await once(child.stdout, 'data');
    await reset();
    // Even a released supervisor and terminal TaskRun cannot hide a live child.
    await releaseTaskRunWriter(turn.id, writer.nonce);
    await unchanged(() => publish(), /requires a finished writer/);
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; exited = true;
    const released = await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id } });
    await unchanged(() => publish(async () => {
      await prisma.taskRun.update({ where: { id: turn.id }, data: { controlMetadata: '{}' } });
    }), /requires a finished writer/);
    await unchanged(() => publish(), /requires a finished writer/);
    await prisma.taskRun.update({ where: { id: turn.id }, data: { controlMetadata: released.controlMetadata } });
    await unchanged(() => submitNodeVerification({ ...request, review: { ...request.review, claimKey: 'stale-claim' } }), /ownership changed/);
    const started = Date.now();
    const result = await publish();
    assert.equal(result.status, 'verifying');
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(after.dispatchMetadata)!;
    assert.equal(after.commit, commit); assert.equal(after.claimToken, 'implementation-claim');
    assert.equal(progress.revision, 8); assert.equal(progress.platformAttempts, 1);
    assert.equal(progress.review?.kind, 'ready'); assert.equal(progress.review?.candidateCommit, commit);
    assert.equal(progress.lastFailure?.code, 'review_platform_failure');
    const platformRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id }, include: { participants: true } });
    assert.match(buildRunReplyCard(platformRun, []).header.title.content, /复核执行失败/);
    assert.doesNotMatch(buildRunReplyCard(platformRun, []).header.title.content, /正式.*未通过/);
    const formal = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'completed', controlMetadata: JSON.stringify({ graphWriter: writer }),
      participants: { create: { executionBackend: 'platform_local', gatewayNameSnapshot: 'local', harnessType: 'codex', role: 'tester', status: 'completed', summary: '检查得到不通过结论' } } } });
    await releaseTaskRunWriter(formal.id, writer.nonce);
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(after.dispatchMetadata, {
      ...progress, review: { kind: 'running', phase, claimKey: 'formal', taskRunId: formal.id, candidateCommit: commit } }) } });
    await submitNodeVerification({ ...request, review: { phase, claimKey: 'formal', taskRunId: formal.id, outcome: 'classified' },
      evidence: { checks: [{ name: 'file', passed: false, evidence: 'Expected field missing' }], summary: '固定候选缺少要求字段' } });
    const failedReview = await prisma.taskRun.findUniqueOrThrow({ where: { id: formal.id }, include: { participants: true } });
    assert.equal(failedReview.status, 'completed', 'A failed acceptance verdict is not a native execution failure');
    assert.match(buildRunReplyCard(failedReview, []).header.title.content, /正式.*未通过/);
    assert.match(JSON.stringify(buildRunReplyCard(failedReview, [])), /固定候选缺少要求字段/);
    console.log(`PASS ${phase}: real exited writer publishes on one connection in ${Date.now() - started} ms; live/unknown/changed writer and stale claim rejected without ledger writes`);
  } finally {
    if (!exited) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.delete({ where: { id: parent.id } });
  }
}

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.match(url.searchParams.get('schema') || '', /^task_graph_test_/);
  assert.equal(url.searchParams.get('connection_limit'), '1', 'Regression must exercise the original single-connection failure');
  try { await scenario('acceptance'); await scenario('architecture'); }
  finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
