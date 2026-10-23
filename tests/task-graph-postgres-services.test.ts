import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { withAttemptServices, type ServiceContext } from '../src/lib/task-graph/attempt-services';
import { runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { validateAttemptServices, validateServices, type PostgresService } from '../src/lib/task-graph/service-contract';

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(20); }
  assert.fail('Expected service state within six seconds');
}
const connects = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect(port, '127.0.0.1');
  const done = (connected: boolean) => { socket.destroy(); resolve(connected); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(200, () => done(false));
});
async function database<T>(context: ServiceContext, action: (client: PrismaClient) => Promise<T>) {
  const connections: unknown = JSON.parse(context.env.TASK_GRAPH_SERVICES_JSON);
  assert.ok(Array.isArray(connections));
  const connection = connections[0];
  assert.equal(connection.runtime, 'postgres'); assert.equal(typeof connection.url, 'string');
  const client = new PrismaClient({ datasources: { db: { url: connection.url } } });
  try { return await action(client); } finally { await client.$disconnect(); }
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'postgres-services-'));
  let scenario = 0;
  const source = path.join(directory, 'resource');
  // The pinned S02 archive contains internal library links. This fixture expands them;
  // the runtime still requires a complete, link-free, hashed resource directory.
  await cp(path.resolve('.cache/sandbox-postgres/pg14.24.0'), source, { recursive: true, dereference: true });
  const service: PostgresService = { key: 'db', runtime: 'postgres', resource: { kind: 'path', path: source, sha256: await runtimeResourceDigest(source) }, startupTimeoutMs: 10_000 };
  // Independently derived from the S02 jar+txz verified by their pinned SHA256, not from this cache.
  assert.equal(service.resource.sha256, '88173c650921e15528294eccd26e6f53d5cc37eb4f8e8035bfe4700c7a98d21d', 'Cached PostgreSQL fixture has drifted');
  const attempts = () => ({ services: [service], manifests: [], directory: path.join(directory, `attempt-${scenario++}`), timeoutMs: 20_000 });
  const run = async (name: string, action: () => Promise<void>) => { await action(); console.log('PASS ' + name); };
  const checkClosed = async (root: string) => {
    for (const folder of await readdir(root)) {
      const attempt = path.join(root, folder);
      const receipt = JSON.parse(await readFile(path.join(attempt, 'receipt.json'), 'utf8'));
      assert.equal(receipt.status, 'closed');
      for (const item of receipt.receipts) { assert.equal(item.closed, true); assert.equal(await connects(item.port), false); }
      assert.deepEqual(await readdir(attempt), ['receipt.json']);
    }
  };
  const variant = async (name: string, initdb: string, realInit = false): Promise<PostgresService> => {
    const resource = path.join(directory, name);
    if (realInit) {
      await cp(source, resource, { recursive: true });
      await rename(path.join(resource, 'bin/initdb'), path.join(resource, 'bin/initdb-real'));
    } else {
      for (const sub of ['bin', 'lib', 'share/postgresql']) await mkdir(path.join(resource, sub), { recursive: true });
      await writeFile(path.join(resource, 'bin/postgres'), '#!/bin/sh\nexit 39\n', { mode: 0o755 });
    }
    await writeFile(path.join(resource, 'bin/initdb'), '#!/bin/sh\nset -eu\n' + initdb, { mode: 0o755 });
    return { ...service, resource: { kind: 'path', path: resource, sha256: await runtimeResourceDigest(resource) } };
  };
  const waitAtInit = async (root: string) => {
    let data = '';
    await eventually(async () => {
      const folders = await readdir(root).catch(() => []);
      for (const folder of folders) {
        data = path.join(root, folder, 'db');
        if (await readFile(path.join(data, 'port-chosen'), 'utf8').then(() => true, () => false)) return true;
      }
      return false;
    });
    return { data, port: Number(await readFile(path.join(data, 'port-chosen'), 'utf8')) };
  };
  try {
    await run('contract rejects unpinned resources, duplicate keys and premature graph admission', async () => {
      assert.throws(() => validateAttemptServices([{ ...service, resource: { ...service.resource, sha256: 'invalid' } }]));
      assert.throws(() => validateAttemptServices([service, service]));
      assert.throws(() => validateServices(JSON.parse(JSON.stringify([service]))));
    });
    await run('real SQL, connection receipt, secret redaction and cleanup', async () => {
      const args = attempts(); const events: string[] = [];
      await withAttemptServices({ ...args, record: async (_kind, payload) => { events.push(JSON.stringify(payload)); } }, async context => {
        assert.equal(context.receipts[0].health, 'healthy');
        const connection = JSON.parse(context.env.TASK_GRAPH_SERVICES_JSON)[0];
        assert.ok(!events.join('').includes(new URL(connection.url).password));
        await database(context, async client => {
          await client.$executeRaw`CREATE TABLE probe (marker text)`;
          await client.$executeRaw`INSERT INTO probe VALUES ('owned database')`;
          assert.deepEqual(await client.$queryRaw`SELECT marker FROM probe`, [{ marker: 'owned database' }]);
        });
      });
      await checkClosed(args.directory);
    });
    await run('two phases own different ports and isolated data', async () => {
      let arrived = 0; let release = () => {};
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const ports: number[] = [];
      const args = [attempts(), attempts()];
      await Promise.all(args.map((arg, index) => withAttemptServices(arg, context => database(context, async client => {
        ports.push(context.receipts[0].port);
        await client.$executeRaw`CREATE TABLE probe (marker int)`;
        await client.$executeRaw`INSERT INTO probe VALUES (${index})`;
        if (++arrived === 2) release();
        await barrier;
        assert.deepEqual(await client.$queryRaw`SELECT marker FROM probe`, [{ marker: index }]);
      }))));
      assert.equal(new Set(ports).size, 2);
      for (const arg of args) await checkClosed(arg.directory);
    });
    await run('resource drift fails before action and partial preparation is removed', async () => {
      const args = attempts();
      await writeFile(path.join(source, 'share/postgresql/s03-drift'), 'changed data file');
      await assert.rejects(withAttemptServices(args, async () => assert.fail('No action for altered bundle')), /SHA256 mismatch/);
      await rm(path.join(source, 'share/postgresql/s03-drift'));
      await checkClosed(args.directory);
    });
    await run('startup failure never exposes a connection', async () => {
      const broken = await variant('broken', 'echo startup-fixture-failed >&2\nexit 29\n');
      const args = { ...attempts(), services: [broken] };
      await assert.rejects(withAttemptServices(args, async () => assert.fail('Broken startup reached action')), /startup-fixture-failed/);
      await checkClosed(args.directory);
    });
    const waitScript = 'echo "$AP_SERVICE_PORT" > "$AP_SERVICE_DATA_DIR/port-chosen"\nwhile [ ! -f "$AP_SERVICE_DATA_DIR/continue" ]; do sleep 0.02; done\n';
    const stalled = await variant('stalled', waitScript);
    await run('startup timeout reaps the namespace', async () => {
      const args = { ...attempts(), services: [{ ...stalled, startupTimeoutMs: 100 }] };
      await assert.rejects(withAttemptServices(args, async () => assert.fail('Timed-out startup reached action')), /健康检查超时/);
      await checkClosed(args.directory);
    });
    await run('cancellation during initdb reaps partial state', async () => {
      const controller = new AbortController(); const args = { ...attempts(), services: [stalled], signal: controller.signal };
      const result = assert.rejects(withAttemptServices(args, async () => assert.fail('Cancelled startup reached action')), /取消/);
      await waitAtInit(args.directory); controller.abort(); await result;
      await checkClosed(args.directory);
    });
    await run('port conflict does not accept or kill an unrelated listener', async () => {
      const collision = await variant('collision', '"$(dirname "$0")/initdb-real" "$@"\n' + waitScript, true);
      const args = { ...attempts(), services: [collision] };
      const result = assert.rejects(withAttemptServices(args, async () => assert.fail('Port collision reached action')), /提前退出|监听进程归属/);
      const { data, port } = await waitAtInit(args.directory);
      const other = createServer(socket => { socket.on('error', () => {}); socket.end('unrelated'); });
      await new Promise<void>((resolve, reject) => { other.once('error', reject); other.listen(port, '127.0.0.1', resolve); });
      try {
        await writeFile(path.join(data, 'continue'), 'go'); await result;
        assert.equal(await connects(port), true, 'Cleanup killed someone else’s listener');
      } finally { await new Promise<void>(resolve => other.close(() => resolve())); }
      await checkClosed(args.directory);
    });
    await run('server exit aborts the action and fails the phase', async () => {
      const args = attempts();
      await assert.rejects(withAttemptServices(args, async context => {
        process.kill(context.receipts[0].pid, 'SIGKILL');
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }), /提前退出|监听进程归属/);
      await checkClosed(args.directory);
    });
    await run('listener loss aborts even while the service wrapper stays alive', async () => {
      const resource = path.join(directory, 'listener-loss');
      await cp(source, resource, { recursive: true });
      await rename(path.join(resource, 'bin/postgres'), path.join(resource, 'bin/postgres-real'));
      await writeFile(path.join(resource, 'bin/postgres'), `#!/bin/sh
set -eu
real="$(dirname "$0")/postgres-real"
if [ "$1" != '-D' ]; then exec "$real" "$@"; fi
"$real" "$@" &
server=$!
while [ ! -f "$AP_SERVICE_DATA_DIR/stop-listener" ]; do sleep 0.02; done
kill -QUIT "$server"
wait "$server" || true
sleep 60
`, { mode: 0o755 });
      const args = { ...attempts(), services: [{ ...service, resource: { ...service.resource, path: resource, sha256: await runtimeResourceDigest(resource) } }] };
      await assert.rejects(withAttemptServices(args, async context => {
        const [folder] = await readdir(args.directory);
        const aborted = new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        await writeFile(path.join(args.directory, folder, 'db/stop-listener'), 'stop');
        await aborted;
        process.kill(context.receipts[0].pid, 0);
      }), /监听进程归属已丢失/);
      await checkClosed(args.directory);
    });
    await run('cancellation after readiness closes database and action failures also clean up', async () => {
      const controller = new AbortController(); const args = { ...attempts(), signal: controller.signal };
      await assert.rejects(withAttemptServices(args, async context => { controller.abort(); assert.equal(context.signal.aborted, true); }), /取消/);
      await checkClosed(args.directory);
      const failed = attempts();
      await assert.rejects(withAttemptServices(failed, async () => { throw new Error('consumer failed'); }), /consumer failed/);
      await checkClosed(failed.directory);
    });
    await run('cleanup errors reject success and remain visible in the receipt', async () => {
      const args = attempts(); let data = '';
      await assert.rejects(withAttemptServices(args, async () => {
        const [folder] = await readdir(args.directory); data = path.join(args.directory, folder, 'db');
        await chmod(data, 0o500);
      }), /服务清理失败/);
      const receipt = JSON.parse(await readFile(path.join(path.dirname(data), 'receipt.json'), 'utf8'));
      assert.match(receipt.failureNote, /服务清理失败/); assert.equal(receipt.receipts[0].closed, false);
      assert.equal(await connects(receipt.receipts[0].port), false);
      await chmod(data, 0o700);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
