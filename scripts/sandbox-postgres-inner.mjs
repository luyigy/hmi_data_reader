/**
 * S02 手动修复：在实际 Bubblewrap 沙箱内运行的一次性 PostgreSQL 会话 runner。
 *
 * 由 scripts/sandbox-postgres-session.mjs 经受控 argv 启动（DATABASE_URL 不经被过滤的环境变量传入）：
 * 1. 用固定版本资源 initdb 并以 pg_ctl -w 启动（TCP loopback、trust、一次性数据目录）；
 * 2. 显式做一次隔离写入/读回/清理探针，留证据；
 * 3. 执行选定的数据库回归套件（scripts/test-task-graph-postgres.mjs <suites>）；
 * 4. 核实回归的 scratch schema 已被回收，然后停止数据库、核实端口关闭、删除数据目录；
 * 全程把命令、版本、退出码、日志与清理结果写入 evidence 目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const suites = (() => {
  const index = argv.indexOf('--suite');
  if (index < 0) return [];
  return argv.slice(index + 1).filter((value) => !value.startsWith('--'));
})();
const resourceDir = arg('resource-dir');
const port = Number(arg('port'));
const user = arg('user');
const database = arg('database');
const evidenceDir = arg('evidence-dir');
for (const [name, value] of [['resource-dir', resourceDir], ['port', String(port)], ['user', user], ['database', database], ['evidence-dir', evidenceDir], ['suite', suites[0]]]) {
  if (!value) throw new Error(`缺少必填参数 --${name}`);
}

const bin = (name) => path.join(resourceDir, 'bin', name);
const evidencePath = (file) => path.join(evidenceDir, file);
const evidence = {
  startedAt: new Date().toISOString(),
  insideSandbox: process.env.AP_TASK_SANDBOX === '1',
  postgres: null,
  databaseUrl: null,
  steps: [],
};
const step = async (name, run) => {
  const started = Date.now();
  try {
    const detail = await run();
    evidence.steps.push({ name, ok: true, durationMs: Date.now() - started, ...detail });
    console.log(`[inner] ${name} OK (${Date.now() - started}ms)`);
  } catch (error) {
    evidence.steps.push({ name, ok: false, durationMs: Date.now() - started, error: String(error?.message || error) });
    console.error(`[inner] ${name} 失败: ${error?.message || error}`);
    throw error;
  }
};
const spawnSyncTool = (file, args) => spawnSync(file, args, { encoding: 'utf8' });
const runTool = (file, args, logName) => {
  const result = spawnSyncTool(file, args);
  appendFileSync(evidencePath(logName), `$ ${path.basename(file)} ${args.join(' ')}\n${result.stdout}${result.stderr}\n[exit ${result.status}]\n`);
  return result;
};

const work = `/tmp/s02-postgres-session-${process.pid}`;
const dataDir = path.join(work, 'data');
const url = `postgres://${user}@127.0.0.1:${port}/${database}`;
evidence.databaseUrl = url;
const client = new PrismaClient({ datasources: { db: { url } } });
let suiteExitCode;
let suiteRan = false;

const tcpProbe = (ms) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = (outcome) => { socket.destroy(); resolve(outcome); };
  socket.setTimeout(ms, () => done({ connected: false, error: 'ETIMEDOUT' }));
  socket.on('connect', () => done({ connected: true }));
  socket.on('error', (error) => done({ connected: false, error: error.code }));
});

try {
  mkdirSync(evidenceDir, { recursive: true });
  await step('postgres-version', async () => {
    const version = runTool(bin('postgres'), ['--version'], 'postgres-version.log');
    if (version.status !== 0) throw new Error(`postgres --version 退出码 ${version.status}`);
    evidence.postgres = version.stdout.trim();
    return { version: version.stdout.trim() };
  });
  await step('initdb', async () => {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(path.join(work, 'sock'), { recursive: true });
    const init = runTool(bin('initdb'), ['-D', dataDir, '-U', user, '--auth=trust', '--no-locale', '-E', 'UTF8'], 'initdb.log');
    if (init.status !== 0) throw new Error(`initdb 退出码 ${init.status}`);
    return { exitCode: init.status };
  });
  await step('pg-ctl-start', async () => {
    const start = runTool(bin('pg_ctl'), ['-D', dataDir, '-l', path.join(work, 'server.log'), '-w', '-t', '60',
      '-o', `-p ${port} -h 127.0.0.1 -k ${path.join(work, 'sock')} -c fsync=off -c full_page_writes=off`, 'start'], 'pg-ctl.log');
    if (start.status !== 0) throw new Error(`pg_ctl start 退出码 ${start.status}`);
    return { exitCode: start.status, note: 'pg_ctl -w 已等待就绪' };
  });
  await step('server-identity', async () => {
    const probe = await tcpProbe(5000);
    if (!probe.connected) throw new Error(`TCP 探针失败: ${probe.error}`);
    const [server] = await client.$queryRaw`SELECT version() AS version, host(inet_server_addr()) AS address`;
    if (!['127.0.0.1', '::1'].includes(server.address)) throw new Error(`服务器地址非 loopback: ${server.address}`);
    return { tcp: probe, serverVersion: server.version, address: server.address, note: 'loopback 直连成立，未使用容器豁免路径' };
  });
  await step('isolated-write', async () => {
    const schema = `s02_probe_${randomUUID().replaceAll('-', '')}`;
    await client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await client.$executeRawUnsafe(`CREATE TABLE "${schema}".probe (id serial primary key, marker text not null)`);
    await client.$executeRawUnsafe(`INSERT INTO "${schema}".probe (marker) VALUES ('sandbox-isolated-write')`);
    const rows = await client.$queryRawUnsafe(`SELECT id, marker FROM "${schema}".probe`);
    if (rows.length !== 1 || rows[0].marker !== 'sandbox-isolated-write') throw new Error(`隔离写入读回不符: ${JSON.stringify(rows)}`);
    await client.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    const leftover = await client.$queryRawUnsafe(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${schema}'`);
    if (leftover.length !== 0) throw new Error('探针 schema 未清理');
    return { schema, wrote: 1, readBack: rows.length, dropped: true };
  });
  await step('regression-suite', async () => {
    suiteRan = true;
    const child = spawn(process.execPath, ['scripts/test-task-graph-postgres.mjs', ...suites], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, ...(argv.includes('--suite-debug') ? { DEBUG_MENTION_DETECTION: 'true' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    appendFileSync(evidencePath('suite.log'), `$ DATABASE_URL=<受控入口提供> node scripts/test-task-graph-postgres.mjs ${suites.join(' ')}\n`);
    const started = Date.now();
    suiteExitCode = await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => { process.stdout.write(chunk); appendFileSync(evidencePath('suite.log'), chunk); });
      child.stderr.on('data', (chunk) => { process.stderr.write(chunk); appendFileSync(evidencePath('suite.log'), chunk); });
      child.on('close', resolve);
    });
    appendFileSync(evidencePath('suite.log'), `\n[exit ${suiteExitCode}] [${Date.now() - started}ms]\n`);
    if (suiteExitCode !== 0) evidence.suiteFailure = `回归套件退出码 ${suiteExitCode}（旧预期与当前代码的分歧见 HANDOVER）`;
    return { suites, exitCode: suiteExitCode };
  });
  await step('suite-schema-cleanup-check', async () => {
    const leftover = await client.$queryRawUnsafe(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'task_graph_test_%'`);
    return { leftoverSchemas: leftover.map((row) => row.schema_name), cleaned: leftover.length === 0 };
  });
} catch (error) {
  evidence.failure = String(error?.message || error);
} finally {
  evidence.cleanup = [];
  try {
    const serverLog = path.join(work, 'server.log');
    try { evidence.serverLogTail = readFileSync(serverLog, 'utf8').split('\n').slice(-8).join('\n'); } catch {}
    const stop = spawnSyncTool(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']);
    evidence.cleanup.push({ action: 'pg_ctl-fast-stop', exitCode: stop.status, note: (stop.stdout + stop.stderr).trim().split('\n').pop() });
    if (stop.status !== 0) {
      const immediate = spawnSyncTool(bin('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', '-t', '30', 'stop']);
      evidence.cleanup.push({ action: 'pg_ctl-immediate-stop', exitCode: immediate.status });
    }
    const status = spawnSyncTool(bin('pg_ctl'), ['-D', dataDir, 'status']);
    evidence.cleanup.push({ action: 'pg_ctl-status-after-stop', exitCode: status.status, running: status.status === 0 });
    evidence.cleanup.push({ action: 'tcp-port-after-stop', ...(await tcpProbe(3000)) });
    rmSync(work, { recursive: true, force: true });
    evidence.cleanup.push({ action: 'remove-data-directory', existsAfter: existsSync(work) });
    await client.$disconnect();
  } catch (cleanupError) {
    evidence.cleanup.push({ action: 'cleanup-error', error: String(cleanupError?.message || cleanupError) });
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(evidencePath('evidence.json'), JSON.stringify(evidence, null, 2));
}
process.exitCode = suiteRan && suiteExitCode !== undefined ? suiteExitCode : (evidence.failure ? 1 : 0);
