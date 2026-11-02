// Real Kimi binary against a loopback-only quota fixture; no real model quota or user history.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
    const result = await executeKimiCodeTask({ id: 'quota', name: 'quota fixture' }, {
      prompt: 'Say hello', workingDirectory: dir, permissionProfile: 'full_access', timeout: 20000,
    });
    assert.ok(requests > 0); assert.equal(result.success, false);
    assert.match(result.error || '', /429[\s\S]*5-hour usage limit/);
    assert.doesNotMatch(result.error || '', /Kimi turn ended: failed/);
    assert.match(JSON.stringify(agentReplyElements({ text: result.error || '' })), /429[\s\S]*5.hour usage limit/, 'failure card body retains the native quota reason');
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
