/** Run database regressions inside Bubblewrap using the same phase lifecycle as graph callers. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node' } });
const { withAttemptServices } = require('../src/lib/task-graph/attempt-services');
const { runtimeResourceDigest } = require('../src/lib/task-graph/runtime-contract');
const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf('--' + name) + 1];
const resourceDir = arg('resource-dir'), evidenceDir = arg('evidence-dir');
const suites = argv.slice(argv.indexOf('--suite') + 1).filter(value => !value.startsWith('--'));
if (!resourceDir || !evidenceDir || !suites.length) throw new Error('Missing resource, evidence directory or suite');
const work = await mkdtemp(path.join(tmpdir(), 'sandbox-postgres-'));
const bundle = path.join(work, 'resource'), attempts = path.join(work, 'attempts');
const evidence = { startedAt: new Date().toISOString(), insideSandbox: process.env.AP_TASK_SANDBOX === '1', suites, steps: [] };
const digest = '88173c650921e15528294eccd26e6f53d5cc37eb4f8e8035bfe4700c7a98d21d';
let port;
try {
  // Only the test fixture normalizes archive-internal links. Production resources must already be link-free.
  await cp(resourceDir, bundle, { recursive: true, dereference: true });
  if (await runtimeResourceDigest(bundle) !== digest) throw new Error('Fixed PostgreSQL bundle drifted');
  await withAttemptServices({ services: [{ key: 'regression', runtime: 'postgres', resource: { kind: 'path', path: bundle, sha256: digest } }], manifests: [], directory: attempts }, async context => {
    const [service] = JSON.parse(context.env.TASK_GRAPH_SERVICES_JSON);
    port = Number(new URL(service.url).port);
    const client = new PrismaClient({ datasources: { db: { url: service.url } } });
    try {
      const [server] = await client.$queryRaw`SELECT version() AS version, host(inet_server_addr()) AS address`;
      if (server.address !== '127.0.0.1') throw new Error('Database is not loopback');
      evidence.postgres = server.version; evidence.sha256 = digest;
      await client.$executeRaw`CREATE TABLE sandbox_probe (marker text)`;
      await client.$executeRaw`INSERT INTO sandbox_probe VALUES ('isolated-write')`;
      const rows = await client.$queryRaw`SELECT marker FROM sandbox_probe`;
      if (rows.length !== 1 || rows[0].marker !== 'isolated-write') throw new Error('SQL readback mismatch');
      await client.$executeRaw`DROP TABLE sandbox_probe`;
      evidence.steps.push({ name: 'isolated-write', ok: true });
      const log = path.join(evidenceDir, 'suite.log');
      const child = spawn(process.execPath, ['scripts/test-task-graph-postgres.mjs', ...suites], {
        env: { ...process.env, DATABASE_URL: service.url, ...(argv.includes('--suite-debug') ? { DEBUG_MENTION_DETECTION: 'true' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const abort = () => child.kill('SIGTERM');
      context.signal.addEventListener('abort', abort, { once: true });
      let writes = Promise.resolve();
      for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => { process[name].write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
      let code;
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { context.signal.removeEventListener('abort', abort); await writes; }
      evidence.steps.push({ name: 'regression-suite', ok: code === 0, exitCode: code });
      const schemas = await client.$queryRaw`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'task_graph_test_%'`;
      evidence.steps.push({ name: 'suite-schema-cleanup', ok: schemas.length === 0 });
      if (code !== 0 || schemas.length) throw new Error(`Regression exit=${code}; leftover scratch schemas=${schemas.length}`);
    } finally { await client.$disconnect(); }
  });
} catch (error) {
  evidence.failure = String(error?.message || error); process.exitCode = 1;
} finally {
  try {
    const receipts = [];
    for (const directory of await readdir(attempts).catch(() => [])) receipts.push(JSON.parse(await readFile(path.join(attempts, directory, 'receipt.json'), 'utf8')));
    const connected = port ? await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(true));
    }) : false;
    const cleaned = receipts.length === 1 && receipts.every(receipt => receipt.status === 'closed' && receipt.receipts.every(item => item.closed));
    evidence.cleanup = { lifecycleClosed: cleaned, portClosed: !connected, receipts };
    if (!cleaned || connected) throw new Error('Phase lifecycle did not close its database');
    await rm(work, { recursive: true, force: true });
    evidence.cleanup.directoryRemoved = true;
  } catch (error) { evidence.cleanupFailure = String(error); process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`[inner] shared phase lifecycle: ${process.exitCode ? 'FAIL' : 'PASS'}; evidence.json includes SQL and cleanup evidence`);
}
