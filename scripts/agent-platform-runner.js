#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let WebSocket;
try { WebSocket = require('ws'); } catch {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const transports = { 'ws:': require('node:http'), 'wss:': require('node:https') };
  WebSocket = class extends EventEmitter {
    static OPEN = 1;
    constructor(value, options = {}) {
      super();
      this.readyState = 0;
      this.buffer = Buffer.alloc(0);
      this.fragments = [];
      const url = new URL(value);
      const key = crypto.randomBytes(16).toString('base64');
      const request = transports[url.protocol].request({
        hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...options.headers },
      });
      request.once('upgrade', (_response, socket, head) => {
        this.socket = socket;
        this.readyState = WebSocket.OPEN;
        socket.on('data', (data) => this.receive(data));
        socket.once('error', (error) => this.emit('error', error));
        socket.once('close', () => { this.readyState = 3; this.emit('close'); });
        this.emit('open');
        if (head.length) this.receive(head);
      });
      request.once('response', (response) => {
        this.emit('error', new Error(`WebSocket upgrade failed (${response.statusCode})`));
        this.close();
      });
      request.once('error', (error) => {
        this.emit('error', error);
        this.close();
      });
      request.end();
    }
    frame(opcode, payload = Buffer.alloc(0)) {
      payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const size = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
      const frame = Buffer.alloc(size + 4 + payload.length);
      frame[0] = 0x80 | opcode;
      if (size === 2) frame[1] = 0x80 | payload.length;
      else if (size === 4) { frame[1] = 0xfe; frame.writeUInt16BE(payload.length, 2); }
      else { frame[1] = 0xff; frame.writeBigUInt64BE(BigInt(payload.length), 2); }
      const maskOffset = size;
      crypto.randomFillSync(frame, maskOffset, 4);
      for (let index = 0; index < payload.length; index++) frame[size + 4 + index] = payload[index] ^ frame[maskOffset + index % 4];
      return frame;
    }
    send(value) { if (this.readyState === WebSocket.OPEN) this.socket.write(this.frame(1, Buffer.from(value))); }
    close() {
      if (this.readyState === 3) return;
      // When the handshake never completed there is no socket to close, but the
      // reconnect loop keys off the 'close' event, so emit it here exactly once.
      if (this.readyState === WebSocket.OPEN) { this.socket.end(this.frame(8)); return; }
      this.readyState = 3;
      this.emit('close');
    }
    receive(data) {
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length >= 2) {
        const first = this.buffer[0];
        const masked = (this.buffer[1] & 0x80) !== 0;
        let length = this.buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
        const maskSize = masked ? 4 : 0;
        if (this.buffer.length < offset + maskSize + length) return;
        const mask = this.buffer.subarray(offset, offset + maskSize);
        const payload = Buffer.from(this.buffer.subarray(offset + maskSize, offset + maskSize + length));
        this.buffer = this.buffer.subarray(offset + maskSize + length);
        if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        const opcode = first & 0x0f;
        if (opcode === 8) { this.socket.end(); continue; }
        if (opcode === 9) { this.socket.write(this.frame(10, payload)); continue; }
        if (opcode === 1 || opcode === 0) this.fragments.push(payload);
        if ((first & 0x80) && (opcode === 1 || opcode === 0)) {
          this.emit('message', Buffer.concat(this.fragments));
          this.fragments = [];
        }
      }
    }
  };
}

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, index, all) => {
  if (!arg.startsWith('--')) return [];
  const separator = arg.indexOf('=');
  const key = arg.slice(2, separator < 0 ? undefined : separator);
  return [[key, separator < 0 ? all[index + 1] : arg.slice(separator + 1)]];
}));
const configDir = path.join(os.homedir(), '.agent-platform');
const configPath = path.join(configDir, 'runner.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
let server = args.server || config.server;
let nodeName = args.node || config.node;
let nodeToken = args.token || config.token;
let workspace = path.resolve(args.workspace || config.workspace || process.cwd());
const piBin = args.pi || process.env.REMOTE_PI_AGENT_BIN || 'pi';
const tools = process.env.REMOTE_PI_AGENT_TOOLS || 'read,bash,edit,write,grep,find,ls';
const children = new Map();
let retryMs = 1000;

const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};
const saveConfig = () => {
  config = { ...config, server, node: nodeName, token: nodeToken, workspace };
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};
const safeCwd = (value) => {
  const cwd = path.resolve(value || workspace);
  if (cwd !== workspace && !cwd.startsWith(`${workspace}${path.sep}`)) throw new Error(`cwd is outside runner workspace: ${cwd}`);
  return cwd;
};
const sessionDirFor = (taskId) => path.join(os.homedir(), '.pi', 'agent', 'sessions', `acpx-${String(taskId).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'default'}`);
const assistantText = (line) => {
  try {
    const event = JSON.parse(line);
    if (event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) return '';
    return event.message.content.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('').trim();
  } catch { return ''; }
};

const spawnPi = (piArgs, cwd) => {
  const options = { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (process.platform !== 'win32') return spawn(piBin, piArgs, options);

  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-platform-prompt-'));
  const promptPath = path.join(promptDir, 'prompt.md');
  fs.writeFileSync(promptPath, piArgs.at(-1), 'utf8');
  const windowsArgs = [...piArgs.slice(0, -1), `@${promptPath}`];
  const command = Buffer.from(piBin, 'utf8').toString('base64');
  const encodedArgs = windowsArgs.map((arg) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(arg, 'utf8').toString('base64')}'))`).join(',');
  const script = `$ErrorActionPreference='Stop'; $pi=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${command}')); [string[]]$piArgs=@(${encodedArgs}); & $pi @piArgs; if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE }`;
  const cleanup = () => fs.rmSync(promptDir, { recursive: true, force: true });
  try {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], options);
    child.once('error', cleanup);
    child.once('exit', cleanup);
    return child;
  } catch (error) {
    cleanup();
    throw error;
  }
};

function run(ws, message) {
  const runId = message.runId;
  if (typeof runId !== 'string' || children.has(runId)) return;
  let cwd;
  try { cwd = safeCwd(message.cwd); } catch (error) {
    send(ws, { type: 'complete', runId, success: false, error: error.message });
    return;
  }
  const sessionDir = typeof message.sessionDir === 'string' && message.sessionDir
    ? message.sessionDir : sessionDirFor(message.taskId);
  const piArgs = ['--mode', 'json', '--tools', tools, '--session-dir', sessionDir];
  if (message.continue) piArgs.push('--continue'); else piArgs.push('-p');
  piArgs.push(String(message.prompt || ''));
  let child;
  try { child = spawnPi(piArgs, cwd); } catch (error) {
    send(ws, { type: 'complete', runId, success: false, error: error.message, sessionDir });
    return;
  }
  children.set(runId, child);
  let finished = false;
  let output = '';
  let stderr = '';
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    const data = chunk.toString();
    send(ws, { type: 'stdout', runId, data });
    stdoutBuffer += data;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) output = assistantText(line) || output;
  });
  child.stderr.on('data', (chunk) => {
    const data = chunk.toString();
    stderr += data;
    send(ws, { type: 'stderr', runId, data });
  });
  child.once('error', (error) => {
    if (finished) return;
    finished = true;
    children.delete(runId);
    send(ws, { type: 'complete', runId, success: false, error: error.message, sessionDir });
  });
  child.once('exit', (code, signal) => {
    if (finished) return;
    finished = true;
    children.delete(runId);
    output = assistantText(stdoutBuffer) || output;
    send(ws, {
      type: 'complete', runId, success: code === 0, output,
      error: code === 0 ? undefined : stderr.trim() || `pi exited with ${signal || `code ${code}`}`,
      sessionDir, filesModified: [],
    });
  });
}

function connect() {
  const url = new URL(server);
  url.searchParams.set('node', nodeName);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${nodeToken}` } });
  ws.on('open', () => {
    retryMs = 1000;
    send(ws, { type: 'hello', node: nodeName, harnesses: ['pi-agent'], workspace });
  });
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'welcome') console.log('connected');
    if (message.type === 'set_workspace' && typeof message.requestId === 'string') {
      try {
        if (typeof message.workspace !== 'string' || !message.workspace.trim()) throw new Error('Workspace is required');
        const requestedWorkspace = path.resolve(message.workspace);
        if (!fs.statSync(requestedWorkspace).isDirectory()) throw new Error(`Workspace is not a directory: ${requestedWorkspace}`);
        workspace = requestedWorkspace;
        saveConfig();
        send(ws, { type: 'workspace_result', requestId: message.requestId, success: true, workspace });
        send(ws, { type: 'hello', node: nodeName, harnesses: ['pi-agent'], workspace });
      } catch (error) {
        send(ws, { type: 'workspace_result', requestId: message.requestId, success: false, error: error.message });
      }
    }
    if (message.type === 'run') run(ws, message);
    if (message.type === 'cancel') {
      const child = children.get(message.runId);
      if (child) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        timer.unref();
      }
    }
  });
  const heartbeat = setInterval(() => send(ws, { type: 'heartbeat' }), 30000);
  heartbeat.unref();
  ws.on('close', () => {
    clearInterval(heartbeat);
    const retryInMs = retryMs;
    console.error(`[runner] connection to ${server} closed; retrying in ${retryInMs}ms`);
    // Keep the retry timer referenced: an unreferenced timer lets the process
    // exit on the first disconnect, which silently cancels the backoff retries.
    setTimeout(connect, retryInMs);
    retryMs = Math.min(retryMs * 2, 30000);
  });
  ws.on('error', (error) => {
    console.error(`[runner] connection to ${server} failed: ${error instanceof Error ? error.message : String(error)}`);
    ws.close();
  });
}

async function start() {
  if (args['pairing-token']) {
    const platform = args.server || process.env.AGENT_PLATFORM_SERVER;
    if (!platform) throw new Error('--server is required when pairing a downloaded runner');
    const response = await fetch(`${platform.replace(/\/$/, '')}/api/runner/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: args['pairing-token'], nodeName: os.hostname() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Pairing failed (${response.status})`);
    server = result.server;
    nodeName = result.nodeName;
    nodeToken = result.nodeSecret;
    saveConfig();
    console.log('paired');
  }
  const missing = [['server', server], ['node', nodeName], ['token', nodeToken]].filter(([, value]) => !value);
  if (missing.length) throw new Error(`Missing required options: ${missing.map(([key]) => `--${key}`).join(', ')}`);
  connect();
}

void start().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
