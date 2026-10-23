import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { redactSensitiveText } from '../redact-sensitive';
import { validateAttemptServices, type AttemptService } from './service-contract';
import { prepareServiceLaunch, type ServiceLaunch } from './service-launch';
import type { TaskInputManifest } from './upstream-inputs';

export class ServiceRuntimeError extends Error {
  constructor(message: string) { super(`联调环境失败：${message}`); this.name = 'ServiceRuntimeError'; Object.setPrototypeOf(this, new.target.prototype); }
}
type Receipt = ServiceLaunch['identity'] & { key: string; argv: string[]; pid: number; port: number; health: 'starting' | 'healthy'; closed: boolean; log: string };
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
  services: AttemptService[]; manifests: TaskInputManifest[]; directory: string; signal?: AbortSignal; timeoutMs?: number; writerNonce?: string;
  record?: (kind: string, payload: object) => Promise<void>;
}, action: (context: ServiceContext) => Promise<T>): Promise<T> {
  validateAttemptServices(args.services);
  const controller = new AbortController();
  if (!args.services.length) return action({ env: {}, signal: args.signal || controller.signal, receipts: [] });
  await mkdir(args.directory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(args.directory, 'services-'));
  const receipts: Receipt[] = []; const children: ChildProcess[] = [];
  const launches: ServiceLaunch[] = [];
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
      const data = path.join(directory, service.key);
      const port = await freePort();
      const launch = await prepareServiceLaunch(service, args.manifests, data, port, controller.signal);
      launches.push(launch);
      controller.signal.throwIfAborted();
      const env = { ...launch.env, ...(args.writerNonce ? { AP_GRAPH_WRITER_NONCE: args.writerNonce } : {}) };
      const wrapped = wrapWithBubblewrap({ command: launch.command, commandArgs: launch.argv, cwd: data, workspaceRoot: data, env,
        networkAccess: 'enabled', readOnlyPaths: launch.readOnlyPaths });
      const child = spawn(wrapped.command, wrapped.args, { cwd: data, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      const receipt: Receipt = { ...launch.identity, key: service.key,
        argv: [launch.command, ...launch.argv], pid: child.pid || 0, port, health: 'starting', closed: false, log: '' };
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
            const healthy = await launch.healthy();
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
    const context: ServiceContext = { env: { TASK_GRAPH_SERVICES_JSON: JSON.stringify(launches.map((launch, index) => ({
      key: receipts[index].key, ...launch.identity, url: launch.url,
    }))) }, signal: controller.signal, receipts };
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
    const cleanupErrors: string[] = [];
    for (const launch of launches) {
      try { await launch.close(); } catch (error) { cleanupErrors.push(String(error)); }
    }
    for (const child of children.reverse()) {
      try { await stop(child); } catch (error) { cleanupErrors.push(String(error)); }
    }
    // Also remove partial preparation directories when a service failed before spawning.
    for (const service of args.services) {
      try {
        await rm(path.join(directory, service.key), { recursive: true, force: true });
        if (service.runtime === 'postgres') await rm(path.join(directory, `${service.key}.resource`), { recursive: true, force: true });
        const receipt = receipts.find(item => item.key === service.key); if (receipt) receipt.closed = true;
      } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (cleanupErrors.length) {
      failureNote = redactSensitiveText([failureNote, '服务清理失败', ...cleanupErrors].filter(Boolean).join('：'));
      await persist('failed');
    }
    await persist('closed');
    if (cleanupErrors.length && failureNote) throw new ServiceRuntimeError(failureNote);
  }
}
