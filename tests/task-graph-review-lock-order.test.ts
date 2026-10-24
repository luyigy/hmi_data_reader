import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PrismaClient, type Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, submitNodeVerification } from '../src/lib/task-graph/store';
import { publishReviewPreparationFailure } from '../src/lib/task-graph/review-publication';
import { reserveGraphReviewClaim } from '../src/lib/task-graph/review-ownership';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { executionProgress, initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type Activity = { pid: number; blockers: number[]; wait: string | null; query: string };

async function scenario(phase: 'acceptance' | 'architecture', preparation: boolean) {
  // Separate single-connection clients expose real SQL contention, not pool queueing.
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('connection_limit', '1');
  const reservationDb = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const observer = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const parent = await prisma.task.create({ data: { name: `lock order ${phase} ${preparation}` } });
  const commit = 'b'.repeat(40), claimKey = `review:${phase}`;
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id,
    definition: { specRef: 'fixture://review-lock-order', nodes: [{ key: 'REVIEW', goal: 'publish without deadlock', dependsOn: [],
      acceptance: { mode: 'agent', reviewerId: 'local:codex', checks: ['file'], reviewLaunchConfig: {
        participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'tester' },
      } }, executions: [{ key: 'repo', repository: process.cwd(), gitRef: 'refs/heads/main', baseCommit: commit,
        agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: graph.id, key: 'REVIEW' } }, include: { executions: true } });
  const writer = await createGraphWriter();
  const turn = await prisma.taskRun.create({ data: { taskId: parent.id, status: 'failed', controlMetadata: JSON.stringify({ graphWriter: writer }),
    participants: { create: { executionBackend: 'platform_local', gatewayNameSnapshot: 'local', harnessType: 'codex', role: 'tester', status: 'failed' } } } });
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: 'ignore' });
  await once(child, 'exit'); await releaseTaskRunWriter(turn.id, writer.nonce);
  const job = node.executions[0];
  await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, claimToken: 'implementation-claim',
    dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...initialExecutionProgress(), phase, revision: 7,
      candidateCommit: commit, workspaceBase: commit, review: { kind: 'running', phase, claimKey, taskRunId: turn.id, candidateCommit: commit } }) } });
  // Rechecking this existing reservation must be a no-op, even while failure publication runs.
  await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: node.id, idempotencyKey: claimKey,
    kind: phase === 'acceptance' ? 'review_claimed' : 'architecture_claimed', payload: {} } });
  const acquired = signal(), release = signal();
  const originalTransaction = prisma.$transaction;
  let reservationPid = 0, publicationPid = 0;
  let reserving: Promise<unknown> | undefined, publishing: Promise<unknown> | undefined;
  const samples: Activity[][] = [];
  const activity = () => observer.$queryRaw<Activity[]>`SELECT pid, pg_blocking_pids(pid) AS blockers,
    wait_event AS wait, query FROM pg_stat_activity WHERE pid IN (${reservationPid}, ${publicationPid}) ORDER BY pid`;
  // Intercept just the next transaction to place a rendezvous after the real advisory lock.
  // All SQL and the production reservation/publication bodies execute unchanged.
  const routeNextTransaction = (db: PrismaClient, reserve: boolean) => {
    prisma.$transaction = (async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      prisma.$transaction = originalTransaction;
      return originalTransaction.call(db, async tx => {
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (reserve) reservationPid = backend.pid; else publicationPid = backend.pid;
        return callback(reserve ? new Proxy(tx, {
          get(target, property, receiver) {
            if (property === '$queryRaw') return async (sql: TemplateStringsArray, ...values: unknown[]) => {
              const result = await target.$queryRaw(sql, ...values);
              if (sql.join('').includes('pg_advisory_xact_lock')) { acquired.resolve(); await release.promise; }
              return result;
            };
            return Reflect.get(target, property, receiver);
          },
        }) : tx);
      });
    }) as typeof prisma.$transaction;
  };
  try {
    routeNextTransaction(reservationDb, true);
    reserving = reserveGraphReviewClaim({ runId: graph.id, nodeId: node.id, phase, claimKey, payload: {} });
    void reserving.catch(() => {});
    await Promise.race([acquired.promise, reserving.then(() => { throw new Error('Reservation ended before the rendezvous'); })]);
    routeNextTransaction(prisma, false);
    publishing = preparation
      ? publishReviewPreparationFailure(node.id, { code: 'environment_failed', detail: 'review environment unavailable' }, true, phase)
      : submitNodeVerification({ runId: graph.id, nodeKey: node.key, actorId: 'local:codex',
        evidence: { checks: [{ name: 'file', passed: false, evidence: 'review environment unavailable' }], summary: 'failed review' },
        review: { phase, claimKey, taskRunId: turn.id, outcome: 'platform_failure' } });
    void publishing.catch(() => {});
    const deadline = Date.now() + 2000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await activity();
      if (rows.some(row => row.pid === publicationPid && row.blockers.includes(reservationPid))) {
        samples.push(rows); blocked = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(blocked, 'Publication must reach an observed SQL wait on the independent reservation connection');
    assert.notEqual(reservationPid, publicationPid);
    release.resolve();
    let settled = false;
    const resultsPromise = Promise.allSettled([reserving, publishing]).then(results => { settled = true; return results; });
    while (!settled) {
      const rows = await activity();
      if (rows.some(row => row.pid === reservationPid && row.blockers.includes(publicationPid)) &&
          rows.some(row => row.pid === publicationPid && row.blockers.includes(reservationPid))) {
        samples.push(rows); break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = await resultsPromise;
    console.log(JSON.stringify({ phase, preparation, samples, results: results.map(result => result.status === 'rejected'
      ? { status: result.status, error: String(result.reason) } : { status: result.status }) }));
    assert.equal(results[0].status, 'fulfilled', 'Existing review reservation must finish without a deadlock');
    assert.equal(results[1].status, 'fulfilled', 'Failure publication must finish without a deadlock');
    assert.equal(await reserving, false);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(after.dispatchMetadata)!;
    assert.equal(after.commit, commit); assert.equal(after.claimToken, 'implementation-claim');
    assert.equal(progress.revision, 8); assert.equal(progress.platformAttempts, 1);
    assert.equal(progress.review?.kind, 'ready'); assert.equal(progress.review?.candidateCommit, commit);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'execution_outcome' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: preparation ? 'review_workspace_failed' : 'verification_failed' } }), 1);
    console.log(`PASS ${phase} ${preparation ? 'preparation' : 'result'}: concurrent reservation and failure publication preserve candidate/claim and consume one retry`);
  } finally {
    prisma.$transaction = originalTransaction; release.resolve();
    await Promise.allSettled([reserving, publishing]);
    await reservationDb.$disconnect(); await observer.$disconnect();
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.task.delete({ where: { id: parent.id } });
  }
}

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const failures: unknown[] = [];
  try {
    for (const phase of ['acceptance', 'architecture'] as const) for (const preparation of [false, true]) {
      try { await scenario(phase, preparation); } catch (error) { failures.push(error); }
    }
    assert.equal(failures.length, 0, failures.map(String).join('\n'));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
