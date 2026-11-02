'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { KimiTranscript } = require('./transcript.cjs');

const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
let child, socket, base, token, sessionId, stopped = false, initialized = false;
let active = false, submitted = false, revision = 0, pending = 0;
let finishing = false;
const transcript = new KimiTranscript(emit);
const receipts = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  socket?.close();
  if (child?.pid) {
    const closed = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([closed, sleep(1500)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  process.exit(code);
}
function fail(error) {
  if (stopped) return;
  // Never include native startup logs: they contain the server credential.
  emit({ type: 'error', message: String(error.message || error).replaceAll(token || '\0', '[REDACTED]') });
  void stop(1);
}
process.on('SIGTERM', () => void stop(1));
process.on('SIGINT', () => void stop(1));
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function api(path, body) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    const error = new Error(`Kimi API ${result.code ?? response.status}: ${result.msg || 'request failed'}`);
    error.code = result.code;
    throw error;
  }
  return result.data;
}
const sessionPath = () => '/sessions/' + encodeURIComponent(sessionId);

async function start(options) {
  child = spawn(options.binary, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: process.env, cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('exit', () => { if (!stopped) fail(new Error('Kimi server exited before completion.')); });
  await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Kimi server startup timed out (requires Server API / kimi web).')), 15000);
    const read = chunk => {
      log = (log + chunk).slice(-65536);
      const match = log.match(/(http:\/\/127\.0\.0\.1:\d+)\/#token=([^\s\x1b]+)/);
      if (!match) return;
      [base, token] = [match[1], match[2]];
      log = '';
      clearTimeout(timer);
      child.stdout.off('data', read); child.stderr.off('data', read);
      // Drain pipes without forwarding authentication or protocol diagnostics.
      child.stdout.resume(); child.stderr.resume();
      resolve();
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  let session;
  if (options.sessionId) {
    sessionId = options.sessionId.startsWith('session_') ? options.sessionId : 'session_' + options.sessionId;
    try { session = await api(sessionPath()); }
    catch (error) { if (error.code === 40401) throw new Error(`Session "${options.sessionId}" not found.`); throw error; }
    if (realpathSync(session.metadata.cwd) !== realpathSync(options.cwd)) throw new Error(`Session "${options.sessionId}" was created under a different directory.`);
    if (session.busy) throw new Error('Kimi session is already busy.');
  } else {
    session = await api('/sessions', { metadata: { cwd: options.cwd } });
    sessionId = session.id;
  }
  emit({ type: 'session', sessionId });
  const status = await api(sessionPath() + '/status');
  const model = options.model || status.model || (await api('/config')).default_model;
  await subscribe();
  if (!model) throw new Error('Kimi has no configured default model.');
  const initialPrompt = 'ap-' + randomUUID();
  await api(sessionPath() + '/prompts', {
    prompt_id: initialPrompt, content: [{ type: 'text', text: options.prompt }],
    permission_mode: 'auto', model,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  });
  submitted = true;
  emit({ type: 'ready' });
  await checkIdle();
}

async function subscribe() {
  socket = new WebSocket(base.replace('http:', 'ws:') + '/api/v1/ws', 'kimi-code.bearer.' + token);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Kimi transcript subscription timed out.')), 5000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe_v2', id: 'subscribe', payload: { session_id: sessionId, transcript: { main: 'delta', '*': 'off' } } })));
    socket.addEventListener('error', () => reject(new Error('Kimi event connection failed.')));
    socket.addEventListener('message', event => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'server_hello' && frame.payload?.protocol_version !== 2) throw new Error('Unsupported Kimi Server protocol version.');
        if (frame.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', payload: {} })); return; }
        if (frame.type === 'ack' && frame.id === 'subscribe') {
          clearTimeout(timer);
          if (frame.code !== 0 || !frame.payload?.accepted?.includes(sessionId)) return reject(new Error('Kimi transcript subscription rejected.'));
          resolve();
        }
        if (frame.session_id !== sessionId) return;
        transcript.accept(frame);
        if (frame.type === 'event.session.work_changed') {
          active = frame.payload.busy;
          if (!active && submitted && !pending) void checkIdle().catch(fail);
        }
        if (frame.type === 'interaction' && frame.status === 'pending') throw new Error('Kimi requires an interaction not supported by autonomous execution.');
      } catch (error) { fail(error); }
    });
    socket.addEventListener('close', () => { clearTimeout(timer); if (!stopped) fail(new Error('Kimi event connection lost; saved session can be resumed. No prompt was replayed.')); });
  });
}

async function checkIdle() {
  const observed = revision;
  const queue = await api(sessionPath() + '/prompts');
  if (!queue.active && !queue.queued.length && !pending && observed === revision && submitted) {
    const session = await api(sessionPath());
    if (session.busy || pending || observed !== revision) return;
    active = false;
    emit({ type: 'idle', revision });
  }
}

async function steer(id, text) {
  const promptId = 'ap-steer-' + id;
  let accepted = false;
  try {
    const result = await api(sessionPath() + '/prompts', { prompt_id: promptId, content: [{ type: 'text', text }] });
    accepted = true;
    if (result.status === 'queued') {
      try { await api(sessionPath() + '/prompts:steer', { prompt_ids: [promptId] }); }
      catch (error) {
        // A turn may finish between enqueue and steer: only accept if it left the queue.
        const queue = await api(sessionPath() + '/prompts');
        if (queue.queued.some(prompt => prompt.prompt_id === promptId)) return 'unknown';
      }
    }
    return 'accepted';
  } catch (error) {
    // A missing response may follow a committed POST. Never invite automatic replay.
    return !accepted && [40001, 40110, 40111, 40112, 40113, 40401, 40931].includes(error.code) ? 'rejected' : 'unknown';
  }
}

const input = createInterface({ input: process.stdin });
input.on('close', () => void stop(1));
input.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'start' && !initialized) { initialized = true; void start(message).catch(fail); }
    else if (message.type === 'steer' && submitted) {
      revision++; pending++;
      let receipt = receipts.get(message.id);
      if (!receipt) { receipt = steer(message.id, message.text); receipts.set(message.id, receipt); }
      void receipt.then(status => {
        emit({ type: 'receipt', id: message.id, status }); pending--;
        return checkIdle();
      }).catch(fail);
    } else if (message.type === 'finish' && message.revision === revision && !pending && !active && !finishing) {
      finishing = true;
      void (async () => {
        const observed = revision;
        const session = await api(sessionPath());
        if (session.busy || pending || observed !== revision) return;
        if (session.last_turn_reason !== 'completed') throw new Error(transcript.failureMessage() || `Kimi turn ended: ${session.last_turn_reason || 'unknown'}`);
        emit({ type: 'result', output: transcript.finish(), sessionId });
        await stop();
      })().catch(fail).finally(() => { finishing = false; });
    }
  } catch (error) { fail(error); }
});
