import assert from 'node:assert/strict';
import { PrismaClient, type Prisma } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Activity = { pid: number; blockers: number[]; wait: string | null; query: string };

/** Route only transaction callbacks; all observations outside them still use global prisma. */
export async function contend(holder: () => Promise<unknown>, contender: () => Promise<unknown>, options: { taskRunId?: string; participantId?: string; holderTransactionContains?: string; skipTransactions?: number; canFinishWithoutWait?: boolean } = {}) {
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('connection_limit', '1');
  const holderDb = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const contenderDb = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const observer = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const probeDbs = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: url.toString() } } }));
  const probePids = [0, 0], probes: Promise<unknown>[] = [];
  const probeDone = [false, false];
  const acquired = signal(), release = signal();
  const original = prisma.$transaction;
  let holderPid = 0, contenderPid = 0;
  const samples: { activity: Activity[]; locks: unknown[] }[] = [];
  let holding: Promise<unknown> | undefined, contending: Promise<unknown> | undefined;
  const activity = () => observer.$queryRaw<Activity[]>`SELECT pid, pg_blocking_pids(pid) AS blockers,
    wait_event AS wait, query FROM pg_stat_activity WHERE pid IN (${holderPid}, ${contenderPid}, ${probePids[0]}, ${probePids[1]}) ORDER BY pid`;
  const capture = async (rows: Activity[]) => samples.push({ activity: rows,
    locks: await observer.$queryRaw`SELECT pid, locktype, mode, granted, relation::regclass::text AS relation,
      transactionid::text, classid::text, objid::text FROM pg_locks
      WHERE pid IN (${holderPid}, ${contenderPid}, ${probePids[0]}, ${probePids[1]}) ORDER BY pid, locktype, mode` });
  const route = (db: PrismaClient, isHolder: boolean) => {
    let skip = isHolder ? 0 : options.skipTransactions || 0;
    prisma.$transaction = (async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      if (isHolder && options.holderTransactionContains && !callback.toString().includes(options.holderTransactionContains)) return original.call(prisma, callback);
      if (skip-- > 0) return original.call(prisma, callback);
      prisma.$transaction = original;
      return original.call(db, async tx => {
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (isHolder) holderPid = backend.pid; else contenderPid = backend.pid;
        let gated = false;
        return callback(isHolder ? new Proxy(tx, { get(target, property, receiver) {
          if (property === '$queryRaw') return async (sql: TemplateStringsArray, ...values: unknown[]) => {
            const result = await target.$queryRaw(sql, ...values);
            if (!gated && sql.join('').includes('pg_advisory_xact_lock')) {
              gated = true; acquired.resolve(); await release.promise;
            }
            return result;
          };
          return Reflect.get(target, property, receiver);
        } }) : tx);
      });
    }) as typeof prisma.$transaction;
  };
  try {
    route(holderDb, true); holding = holder(); void holding.catch(() => {});
    await Promise.race([acquired.promise, holding.then(value => { throw new Error('Holder never reached graph-control: ' + JSON.stringify(value)); })]);
    route(contenderDb, false); contending = contender(); void contending.catch(() => {});
    let blocked = false, finished = false;
    void contending.then(() => { finished = true; }, () => { finished = true; });
    for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
      const rows = await activity();
      if (rows.some(row => row.pid === contenderPid && row.blockers.includes(holderPid))) {
        await capture(rows); blocked = true; break;
      }
      if (finished && options.canFinishWithoutWait) break;
      await new Promise(done => setTimeout(done, 10));
    }
    assert(blocked || finished && options.canFinishWithoutWait, 'Contender must reach a real SQL wait, not a connection pool queue');
    assert.notEqual(holderPid, contenderPid);
    if (options.taskRunId && options.participantId) {
      for (let index = 0; index < probeDbs.length; index++) {
        const db = probeDbs[index];
        probes.push(db.$transaction(async tx => {
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          probePids[index] = backend.pid;
          if (index === 0) await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${options.taskRunId} FOR UPDATE`;
          else await tx.$queryRaw`SELECT id FROM "TaskRunParticipant" WHERE id = ${options.participantId} FOR UPDATE`;
        }).finally(() => { probeDone[index] = true; }));
      }
      for (const deadline = Date.now() + 500; Date.now() < deadline;) {
        const rows = await activity();
        if (probeDone.every(Boolean) || probePids.every((pid, index) => probeDone[index] || rows.some(row => row.pid === pid && row.blockers.includes(contenderPid)))) {
          await capture(rows); break;
        }
        await new Promise(done => setTimeout(done, 10));
      }
    }
    release.resolve();
    let settled = false;
    const resultsPromise = Promise.allSettled([holding, contending]).then(results => { settled = true; return results; });
    while (!settled) {
      const rows = await activity();
      if (rows.some(row => row.pid === holderPid && row.blockers.includes(contenderPid)) &&
          rows.some(row => row.pid === contenderPid && row.blockers.includes(holderPid))) { await capture(rows); break; }
      await new Promise(done => setTimeout(done, 10));
    }
    const results = await resultsPromise;
    await Promise.all(probes);
    return { holderPid, contenderPid, probePids, probeTargets: { taskRunId: options.taskRunId, participantId: options.participantId }, samples, results: results.map(result => result.status === 'rejected'
      ? { status: result.status, error: String(result.reason) } : { status: result.status, value: result.value }) };
  } finally {
    prisma.$transaction = original; release.resolve();
    await Promise.allSettled([holding, contending, ...probes]);
    await Promise.all([holderDb.$disconnect(), contenderDb.$disconnect(), observer.$disconnect(), ...probeDbs.map(db => db.$disconnect())]);
  }
}
