// Real Kimi binary against a loopback-only quota fixture; no real model quota or user history.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { agentReplyElements } from '../src/lib/agent-reply-card';
import { executeKimiCodeTask } from '../src/lib/real-agents/kimi-code-agent';
async function main() {
  const binary = process.env.KIMI_SERVER_NATIVE_BIN;
  if (!binary) { console.log('Skip native quota check: set KIMI_SERVER_NATIVE_BIN'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-quota-native-'));
  const home = path.join(dir, 'home'); await mkdir(home);
  const previous = { binary: process.env.KIMI_CODE_CLI_PATH, home: process.env.KIMI_CODE_HOME, transport: process.env.KIMI_CODE_TRANSPORT };
  process.env.KIMI_CODE_CLI_PATH = binary; process.env.KIMI_CODE_HOME = home; delete process.env.KIMI_CODE_TRANSPORT;
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); requests++;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'insufficient_quota', message: "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    await writeFile(path.join(home, 'config.toml'), `default_model = "smoke/smoke"\n[providers.smoke]\nbase_url = "http://127.0.0.1:${address.port}/v1"\ntype = "openai"\napi_key = "test"\n[models."smoke/smoke"]\nprovider = "smoke"\nmodel = "smoke"\nmax_context_size = 128000\n`);
    let sessionId: string | undefined;
    const workspace = path.join(dir, 'workspace'); await mkdir(workspace);
    const result = await executeKimiCodeTask({ id: 'quota', name: 'quota fixture' }, {
      prompt: 'Say hello', workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'enabled', permissionProfile: 'safe_local', timeout: 20000,
      onSessionStarted: id => { sessionId = id; },
    });
    assert.ok(requests > 0); assert.equal(result.success, false);
    assert.match(result.error || '', /429[\s\S]*5-hour usage limit/);
    assert.doesNotMatch(result.error || '', /Kimi turn ended: failed/);
    assert.match(JSON.stringify(agentReplyElements({ text: result.error || '' })), /429[\s\S]*5.hour usage limit/, 'failure card body retains the native quota reason');
    assert.ok(sessionId);
    const lock = path.join(home, 'locks/sessions', sessionId + '.lock');
    await assert.rejects(readFile(lock), { code: 'ENOENT' }, 'failed native server releases its lock before returning');
    const resumed = await executeKimiCodeTask({ id: 'quota', name: 'quota resume fixture' }, {
      prompt: 'New user request', sessionId, workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'enabled', permissionProfile: 'safe_local', timeout: 20000,
    });
    assert.match(resumed.error || '', /429[\s\S]*5-hour usage limit/);
    assert.equal(requests, 2, 'each new user request was submitted once');
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    const occupied = JSON.stringify({ version: 1, token: 'occupied-fixture', pid: 1, hostname: hostname(), startedAt: Date.now(), clientIdentity: 'kimi_code_cli', clientDisplayName: 'Kimi Code Web' });
    await writeFile(lock, occupied);
    const blocked = await executeKimiCodeTask({ id: 'quota', name: 'occupied lock fixture' }, {
      prompt: 'Must not submit', sessionId, workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'enabled', permissionProfile: 'safe_local', timeout: 20000,
    });
    assert.equal(blocked.success, false);
    assert.match(blocked.error || '', /40931/);
    assert.equal(await readFile(lock, 'utf8'), occupied, 'an occupied lock is never removed');
    assert.equal(requests, 2);
    console.log(JSON.stringify({ nativeQuotaError: result.error, requests, realModelCalls: 0 }));
  } finally {
    for (const [key, value] of Object.entries({ KIMI_CODE_CLI_PATH: previous.binary, KIMI_CODE_HOME: previous.home, KIMI_CODE_TRANSPORT: previous.transport })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
