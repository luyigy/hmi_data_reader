import assert from 'node:assert/strict';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';

async function main() {
  const schema = new URL(process.env.DATABASE_URL || '').searchParams.get('schema');
  assert.match(schema || '', /^task_graph_test_[a-f0-9]+$/);
  const root = await fs.mkdtemp(path.join(tmpdir(), 'p0-service-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', DATABASE_URL: process.env.DATABASE_URL,
    AUTH_ADMIN_USERNAME: 'p0-test-admin', AUTH_ADMIN_PASSWORD: password, AUTH_SESSION_SECRET: randomBytes(32).toString('hex'),
    AUTH_SESSION_TTL_SECONDS: '3600', NEXT_TELEMETRY_DISABLED: '1' };
  let webLog = ''; let graphLog = ''; let graph: ChildProcess | undefined;
  const snapshots: unknown[] = [];
  const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  web.stdout.on('data', data => { webLog += data.toString(); }); web.stderr.on('data', data => { webLog += data.toString(); });
  try {
    let healthy = false;
    for (let n = 0; n < 120; n++) {
      if (web.exitCode !== null) throw new Error('Isolated Next process exited before health check');
      try { const response: Response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) }); healthy = response.ok && (await response.json()).ok === true; } catch { /* Cold compilation may still be in progress. */ }
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(healthy, 'Isolated Next health endpoint must become healthy');
    assert.equal((await fetch(base + '/api/tasks/fixture')).status, 401);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env.AUTH_ADMIN_USERNAME, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    assert.equal((await fetch(base + '/api/task-graph-runs?parentTaskId=fixture', { headers: { cookie } })).status, 404, 'Keep the existing deny rule for graph HTTP routes');
    const pending: Promise<void>[] = [];
    graph = fork(path.resolve('tests/task-graph-issue-execution.test.ts'), [], { env: { ...process.env, AP_P0_SERVICE_PROBE: '1', AP_S01_REVIEW_RELEASE_PROBE: '1' },
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    graph.stdout?.on('data', data => { graphLog += data.toString(); }); graph.stderr?.on('data', data => { graphLog += data.toString(); });
    graph.on('message', (message: unknown) => {
      const work = (async () => {
        assert.ok(message && typeof message === 'object' && 'kind' in message && message.kind === 'p0-state' && 'stage' in message && 'runId' in message && typeof message.runId === 'string');
        const nodes = await prisma.taskGraphNode.findMany({ where: { runId: message.runId }, include: { executions: true }, orderBy: { key: 'asc' } });
        const states = Object.fromEntries(nodes.map(node => [node.key, node.status]));
        assert.deepEqual(states, message.stage === 'paused' ? { A: 'passed', B: 'attention', C: 'planned' } : { A: 'passed', B: 'passed', C: 'passed' });
        const taskRunStates: Record<string, string> = {};
        for (const node of nodes) for (const job of node.executions) if (job.childTaskId) {
          const response: Response = await fetch(`${base}/api/tasks/${job.childTaskId}/runs/latest?runId=${job.taskRunId}`, { headers: { cookie }, signal: AbortSignal.timeout(45000) });
          assert.equal(response.status, 200);
          const value: unknown = await response.json();
          assert.ok(value && typeof value === 'object' && 'taskId' in value && value.taskId === job.childTaskId && 'latestRun' in value);
          const latest = value.latestRun;
          assert.ok(latest && typeof latest === 'object' && 'id' in latest && 'status' in latest);
          assert.deepEqual({ id: latest.id, status: latest.status }, { id: job.taskRunId, status: 'completed' }, 'HTTP must return this execution’s exact completed TaskRun');
          taskRunStates[node.key] = String(latest.status);
        }
        const after = await prisma.taskGraphNode.findMany({ where: { runId: message.runId }, orderBy: { key: 'asc' } });
        assert.deepEqual(Object.fromEntries(after.map(node => [node.key, node.status])), states, 'HTTP status reads cannot release graph nodes');
        snapshots.push({ stage: message.stage, states, taskRunStates }); graph?.send({ kind: 'verified' });
      })();
      pending.push(work); work.catch(() => graph?.kill('SIGTERM'));
    });
    const deadline = setTimeout(() => graph?.kill('SIGTERM'), 180000);
    try { const [code] = await once(graph, 'exit'); await Promise.all(pending); assert.equal(code, 0, graphLog); }
    finally { clearTimeout(deadline); }
    assert.equal(snapshots.length, 2);
    const files = ['conversation-followup.ts', 'coordinator.ts', 'execution-progress.ts', 'review-recovery.ts', 'writer-snapshot.ts'];
    const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(`src/lib/task-graph/${file}`)).digest('hex')])));
    const receipt = { isolated: true, host: '127.0.0.1', port, schema, health: true, unauthorizedStatus: 401, loginStatus: 200, snapshots, sourceSha256: sources, productionRestarted: false };
    if (process.env.AP_P0_SERVICE_RECEIPT) await fs.writeFile(process.env.AP_P0_SERVICE_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (graph && graph.exitCode === null && graph.signalCode === null) { const exit = once(graph, 'exit'); graph.kill('SIGTERM'); await exit; }
    if (web.exitCode === null && web.signalCode === null && web.pid) { const exit = once(web, 'exit'); process.kill(-web.pid, 'SIGTERM'); await exit; }
    if (process.env.AP_P0_SERVICE_LOG) await fs.writeFile(process.env.AP_P0_SERVICE_LOG, webLog);
    await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
