import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { redactSensitiveText } from '../redact-sensitive';
import { validateServices, type GraphService } from './service-contract';
import type { TaskInputManifest } from './upstream-inputs';

export class ServiceRuntimeError extends Error {
  constructor(message: string) { super(`联调环境失败：${message}`); this.name = 'ServiceRuntimeError'; Object.setPrototypeOf(this, new.target.prototype); }
}
type Receipt = { key: string; input: string; commit: string; inputHash: string; sourcePath: string; entry: string;
  argv: string[]; pid: number; port: number; health: 'starting' | 'healthy'; closed: boolean; log: string };
export type ServiceContext = { env: Record<string, string>; signal: AbortSignal; receipts: Receipt[] };

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
/** A successful HTTP response is insufficient: the listening socket must belong to this namespace's process tree. */
async function ownsListener(pid: number, port: number) {
  const rows = (await readFile('/proc/net/tcp', 'utf8')).split('\n').map(line => line.trim().split(/\s+/));
  const inode = rows.find(row => row[1] === `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}` && row[3] === '0A')?.[9];
  if (!inode) return false;
  const queue = [pid]; const visited = new Set<number>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      for (const tid of await readdir(`/proc/${current}/task`)) {
        const children = await readFile(`/proc/${current}/task/${tid}/children`, 'utf8');
        queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
      }
      for (const fd of await readdir(`/proc/${current}/fd`)) {
        const { readlink } = await import('node:fs/promises');
        if (await readlink(`/proc/${current}/fd/${fd}`).catch(() => '') === `socket:[${inode}]`) return true;
      }
    } catch { /* A child can exit while /proc is inspected. */ }
  }
  return false;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  await Promise.race([exited, delay(200)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  await exited;
}

/** Every phase owns its services. Bubblewrap kills descendants if this owner crashes. */
export async function withAttemptServices<T>(args: {
  services: GraphService[]; manifests: TaskInputManifest[]; directory: string; signal?: AbortSignal; timeoutMs?: number; writerNonce?: string;
  record?: (kind: string, payload: object) => Promise<void>;
}, action: (context: ServiceContext) => Promise<T>): Promise<T> {
  validateServices(args.services);
  const controller = new AbortController();
  if (!args.services.length) return action({ env: {}, signal: args.signal || controller.signal, receipts: [] });
  await mkdir(args.directory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(args.directory, 'services-'));
  const receipts: Receipt[] = []; const children: ChildProcess[] = [];
  const abort = () => controller.abort(new ServiceRuntimeError('阶段已取消'));
  args.signal?.addEventListener('abort', abort, { once: true });
  if (args.signal?.aborted) abort();
  const deadline = setTimeout(() => controller.abort(new ServiceRuntimeError('阶段联调超时')), args.timeoutMs || 30 * 60_000);
  let closing = false;
  let failureNote: string | null = null;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  const fail = (message: string) => { if (!closing) controller.abort(new ServiceRuntimeError(message)); };
  const persist = async (status: string) => {
    const payload = { status, directory, receipts, failureNote };
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(payload, null, 2));
    await args.record?.(status === 'closed' ? 'service_attempt_closed' : status === 'failed' ? 'service_attempt_failed' : 'service_attempt_ready', payload);
  };
  try {
    for (const service of args.services) {
      controller.signal.throwIfAborted();
      const candidates = args.manifests.flatMap(manifest => manifest.inputs.filter(input => input.executions.includes(service.input)).map(input => ({ input, hash: manifest.hash })));
      if (!candidates.length || new Set(candidates.map(({ input }) => `${input.repository}@${input.commit}`)).size !== 1) throw new ServiceRuntimeError('服务输入未消费或版本不唯一：' + service.input);
      const { input, hash } = candidates[0];
      const entry = await realpath(path.join(input.sourcePath, service.entry));
      if (!entry.startsWith(input.sourcePath + path.sep)) throw new ServiceRuntimeError('服务入口越出固定源码');
      const data = path.join(directory, service.key); await mkdir(data, { mode: 0o700 });
      const port = await freePort();
      const command = service.runtime === 'python' ? input.pythonExecutable : process.execPath;
      if (!command) throw new ServiceRuntimeError('前置没有登记 Python 环境：' + service.input);
      const argv = [...(service.runtime === 'python' ? ['-E', '-s', '-B'] : []), entry,
        ...service.args.map(arg => arg.replaceAll('{port}', String(port)).replaceAll('{data}', data))];
      // Do not inherit model, database, proxy or host project import credentials into a test service.
      const env: NodeJS.ProcessEnv = { ...(args.writerNonce ? { AP_GRAPH_WRITER_NONCE: args.writerNonce } : {}), NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0',
        NODE_PATH: input.dependencyPaths.filter(directory => path.basename(directory) === 'node_modules').join(path.delimiter),
        AP_PROJECT_REPOSITORY: input.repository, AP_SERVICE_DATA_DIR: data, AP_SERVICE_PORT: String(port), AP_SERVICE_HOST: '127.0.0.1' };
      const wrapped = wrapWithBubblewrap({ command, commandArgs: argv, cwd: data, workspaceRoot: data, env, networkAccess: 'enabled',
        readOnlyPaths: [input.sourcePath, ...input.dependencyPaths, ...(input.projectEnvPath ? [input.projectEnvPath] : [])] });
      const child = spawn(wrapped.command, wrapped.args, { cwd: data, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      const receipt: Receipt = { key: service.key, input: service.input, commit: input.commit, inputHash: hash, sourcePath: input.sourcePath,
        entry, argv: [command, ...argv], pid: child.pid || 0, port, health: 'starting', closed: false, log: '' };
      receipts.push(receipt);
      const log = (chunk: Buffer) => { receipt.log = redactSensitiveText((receipt.log + chunk.toString('utf8')).slice(-16_384)); };
      child.stdout?.on('data', log); child.stderr?.on('data', log);
      child.once('error', error => fail(error.message));
      child.once('exit', (code, signal) => fail(`${service.key} 提前退出 ${code ?? signal}：${receipt.log.slice(-1000)}`));
      const until = Date.now() + (service.startupTimeoutMs || 30_000);
      while (true) {
        controller.signal.throwIfAborted();
        if (Date.now() > until) throw new ServiceRuntimeError(service.key + ' 健康检查超时');
        const owned = receipt.pid && await ownsListener(receipt.pid, port);
        if (owned) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}${service.healthPath}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]), redirect: 'error' });
            const healthy = response.ok; await response.body?.cancel();
            if (healthy && await ownsListener(receipt.pid, port)) { receipt.health = 'healthy'; break; }
          } catch { controller.signal.throwIfAborted(); }
        }
        await delay(25);
      }
    }
    await persist('ready');
    monitor = setInterval(() => {
      if (checking || closing) return;
      checking = true;
      Promise.all(receipts.map(async receipt => {
        if (!await ownsListener(receipt.pid, receipt.port)) fail(receipt.key + ' 的监听进程归属已丢失');
      })).catch(error => fail(String(error))).finally(() => { checking = false; });
    }, 250);
    const context: ServiceContext = { env: { TASK_GRAPH_SERVICES_JSON: JSON.stringify(receipts.map(item => ({ key: item.key, input: item.input, commit: item.commit, inputHash: item.inputHash, entry: item.entry, url: `http://127.0.0.1:${item.port}` }))) }, signal: controller.signal, receipts };
    controller.signal.throwIfAborted();
    const result = await action(context);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    failureNote = redactSensitiveText(error instanceof Error ? error.message : String(error));
    await persist('failed');
    throw error instanceof ServiceRuntimeError ? error : new ServiceRuntimeError(failureNote);
  } finally {
    closing = true; clearTimeout(deadline); if (monitor) clearInterval(monitor); args.signal?.removeEventListener('abort', abort);
    for (const child of children.reverse()) await stop(child);
    for (const receipt of receipts) { receipt.closed = true; await rm(path.join(directory, receipt.key), { recursive: true, force: true }); }
    await persist('closed');
  }
}
