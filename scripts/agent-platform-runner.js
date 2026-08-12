#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, index, all) => {
  if (!arg.startsWith('--')) return [];
  const separator = arg.indexOf('=');
  const key = arg.slice(2, separator < 0 ? undefined : separator);
  return [[key, separator < 0 ? all[index + 1] : arg.slice(separator + 1)]];
}));
const required = ['server', 'node', 'token', 'workspace'];
const missing = required.filter((key) => !args[key]);
if (missing.length) {
  console.error(`Missing required options: ${missing.map((key) => `--${key}`).join(', ')}`);
  process.exit(2);
}

const workspace = path.resolve(args.workspace);
const piBin = args.pi || process.env.REMOTE_PI_AGENT_BIN || 'pi';
const tools = process.env.REMOTE_PI_AGENT_TOOLS || 'read,bash,edit,write,grep,find,ls';
const children = new Map();
let retryMs = 1000;

const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
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
  const child = spawn(piBin, piArgs, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(runId, child);
  let finished = false;
  let output = '';
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    const data = chunk.toString();
    send(ws, { type: 'stdout', runId, data });
    stdoutBuffer += data;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) output = assistantText(line) || output;
  });
  child.stderr.on('data', (chunk) => send(ws, { type: 'stderr', runId, data: chunk.toString() }));
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
      error: code === 0 ? undefined : `pi exited with ${signal || `code ${code}`}`,
      sessionDir, filesModified: [],
    });
  });
}

function connect() {
  const url = new URL(args.server);
  url.searchParams.set('node', args.node);
  url.searchParams.set('secret', args.token);
  const ws = new WebSocket(url);
  ws.on('open', () => {
    retryMs = 1000;
    send(ws, { type: 'hello', node: args.node, harnesses: ['pi-agent'], workspace });
  });
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
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
    setTimeout(connect, retryMs).unref();
    retryMs = Math.min(retryMs * 2, 30000);
  });
  ws.on('error', () => ws.close());
}
connect();
