/* eslint-disable @typescript-eslint/no-require-imports */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Dispatcher } from 'undici-types';
import { executeRemoteRunnerTask } from '../src/lib/remote-harness/runner-executor';

async function main() {
  // Exercise native fetch with an accelerated idle timeout, not a mocked rejection.
  await fetch('data:text/plain,init');
  const dispatcherKey = Symbol.for('undici.globalDispatcher.1');
  const globals = globalThis as unknown as Record<symbol, Dispatcher>;
  const dispatcher = globals[dispatcherKey];
  assert(dispatcher);
  globals[dispatcherKey] = {
    dispatch: (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers) =>
      dispatcher.dispatch({ ...options, bodyTimeout: 100, headersTimeout: 100 }, handler),
  } as Dispatcher;

  const originalCreateServer = http.createServer;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();
  const intervals: number[] = [];
  global.setInterval = ((callback: () => void, ms: number) => {
    intervals.push(ms);
    const timer = originalSetInterval(callback, 30);
    activeIntervals.add(timer);
    return timer;
  }) as typeof setInterval;
  global.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    activeIntervals.delete(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;

  let server: http.Server | undefined;
  http.createServer = ((...args: Parameters<typeof http.createServer>) => {
    server = originalCreateServer(...args);
    return server;
  }) as typeof http.createServer;

  const pending = new Map<string, { resolve: (value: unknown) => void; timer?: ReturnType<typeof setTimeout> }>();
  const cancellations: string[] = [];
  const nodeWs = require('../src/lib/remote-node-ws') as Record<string, unknown>;
  nodeWs.executeOnNode = async (_node: string, request: { taskId: string; runId: string }, callbacks: { onStdout: (data: string) => void }) => {
    if (request.taskId === 'offline') throw new Error('Remote node is offline: fixture');
    return new Promise((resolve) => {
      const entry: { resolve: (value: unknown) => void; timer?: ReturnType<typeof setTimeout> } = { resolve };
      pending.set(request.runId, entry);
      if (request.taskId === 'silent' || request.taskId === 'silent-start') {
        if (request.taskId === 'silent') callbacks.onStdout('building\n');
        entry.timer = setTimeout(() => {
          pending.delete(request.runId);
          callbacks.onStdout('finished\n');
          resolve({ success: true, output: 'done' });
        }, 2200);
      }
      if (request.taskId === 'failure') {
        pending.delete(request.runId);
        resolve({ success: false, error: 'provider rejected request' });
      }
    });
  };
  nodeWs.cancelNodeRun = (_node: string, runId: string) => {
    cancellations.push(runId);
    const entry = pending.get(runId);
    clearTimeout(entry?.timer);
    entry?.resolve({ success: false, error: 'cancelled' });
    pending.delete(runId);
  };

  const previousUrl = process.env.REMOTE_RUNNER_GATEWAY_URL;
  const previousPort = process.env.REMOTE_RUNNER_GATEWAY_PORT;
  const previousHost = process.env.REMOTE_RUNNER_GATEWAY_HOST;
  process.env.REMOTE_RUNNER_GATEWAY_PORT = '0';
  process.env.REMOTE_RUNNER_GATEWAY_HOST = '127.0.0.1';
  const base = { nodeName: 'fixture', cwd: '/fixture', prompt: 'fixture', timeout: 10000 };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    require('../scripts/remote-runner-gateway');
    assert(server);
    const gateway: http.Server = server;
    if (!gateway.listening) await new Promise<void>((resolve) => gateway.once('listening', resolve));
    const address = gateway.address();
    assert(address && typeof address === 'object');
    process.env.REMOTE_RUNNER_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    const stdout: string[] = [];
    const result = await executeRemoteRunnerTask({ ...base, taskId: 'silent', streamCallbacks: {
      onStdoutChunk: (text) => { stdout.push(text); },
    } });
    assert.equal(result.output, 'done');
    assert.deepEqual(stdout, ['building\n', 'finished\n'], 'transport heartbeats must not become agent output');
    await settle();
    assert.equal(cancellations.length, 0);
    assert.equal(activeIntervals.size, 0, 'normal completion releases heartbeat');
    assert(intervals.length > 0 && intervals.every(ms => ms > 0 && ms <= 30000));
    assert.equal((await executeRemoteRunnerTask({ ...base, taskId: 'silent-start' })).output, 'done');
    await settle();
    assert.equal(activeIntervals.size, 0);
    console.log('silent execution survives HTTP body/header idle timeouts; heartbeat is invisible and cleaned up');

    await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'failure' }), /provider rejected request/);
    await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'offline' }), /Remote node is offline/);
    await settle();
    assert.equal(cancellations.length, 0, 'settled failures must not send redundant cancellation');
    assert.equal(activeIntervals.size, 0, 'failed execution releases heartbeat');

    await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'timeout', timeout: 200 }), /Remote runner timed out after 200ms/);
    await settle();
    assert.equal(cancellations.length, 1, 'task deadline still cancels exactly once despite heartbeats');
    assert.equal(activeIntervals.size, 0);

    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'interrupt', onControl: (control) => {
      interruptTimer = setTimeout(() => control.kill(), 200);
    } }), /Remote runner interrupted/);
    clearTimeout(interruptTimer);
    await settle();
    assert.equal(cancellations.length, 2);
    assert.equal(activeIntervals.size, 0, 'client disconnect releases heartbeat');
    console.log('provider failure, offline node, task deadline and interruption passed');

    // A legacy or broken gateway must expose the native error cause, not just "terminated".
    const broken = originalCreateServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { taskId } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { taskId: string };
      if (taskId === 'header-timeout') return;
      if (taskId === 'socket-close') setTimeout(() => res.destroy(), 40);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"heartbeat"}\n');
    });
    await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve));
    const brokenAddress = broken.address();
    assert(brokenAddress && typeof brokenAddress === 'object');
    process.env.REMOTE_RUNNER_GATEWAY_URL = `http://127.0.0.1:${brokenAddress.port}`;
    try {
      await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'body-timeout' }), /输出流.*超时.*UND_ERR_BODY_TIMEOUT/);
      await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'header-timeout' }), /网关响应超时.*UND_ERR_HEADERS_TIMEOUT/);
      await assert.rejects(executeRemoteRunnerTask({ ...base, taskId: 'socket-close' }), /连接失败.*UND_ERR_SOCKET/);
    } finally {
      broken.closeAllConnections();
      await new Promise<void>(resolve => broken.close(() => resolve()));
    }
    console.log('native body/header timeouts and socket close retain actionable causes');
  } finally {
    for (const entry of Array.from(pending.values())) { clearTimeout(entry.timer); entry.resolve({ success: false, error: 'test cleanup' }); }
    for (const timer of Array.from(activeIntervals)) originalClearInterval(timer);
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    http.createServer = originalCreateServer;
    globals[dispatcherKey] = dispatcher;
    for (const [key, value] of Object.entries({ REMOTE_RUNNER_GATEWAY_URL: previousUrl, REMOTE_RUNNER_GATEWAY_PORT: previousPort, REMOTE_RUNNER_GATEWAY_HOST: previousHost })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
