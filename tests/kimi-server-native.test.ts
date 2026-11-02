// Optional: KIMI_SERVER_NATIVE_BIN=/path/to/kimi. Real CLI, local provider, no external model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeKimiCodeTask } from '../src/lib/real-agents/kimi-code-agent';
import { collectKimiCodeSessionTelemetry } from '../src/lib/real-agents/kimi-code-telemetry';
import { readKimiSessionBytes } from '../src/lib/real-agents/session-size-readers';
import type { HarnessSteer } from '../src/lib/acpx/types';

async function main() {
  const binary = process.env.KIMI_SERVER_NATIVE_BIN;
  if (!binary) { console.log('Skip native Kimi: set KIMI_SERVER_NATIVE_BIN'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-server-native-'));
  const home = path.join(dir, 'home'); await mkdir(home);
  const previous = { binary: process.env.KIMI_CODE_CLI_PATH, home: process.env.KIMI_CODE_HOME, transport: process.env.KIMI_CODE_TRANSPORT };
  process.env.KIMI_CODE_CLI_PATH = binary; process.env.KIMI_CODE_HOME = home; delete process.env.KIMI_CODE_TRANSPORT;
  let steer: HarnessSteer | undefined, requests = 0, tools = 0, registrations = 0, releases = 0;
  let receipts: Promise<string>[] = [];
  let sandboxCommand: string | undefined;
  const histories: string[] = [], progress: { text: string; phase?: string | null }[] = [];
  const model = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      histories.push(body); requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123 } } : {}) })}\n\n`);
      send({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING_MUST_NOT_LEAVE_BRIDGE' });
      setTimeout(() => {
        if (requests === 1) {
          assert.ok(steer, 'native registration precedes steering');
          receipts = [steer('first', '追加 FIRST'), steer('second', '追加 SECOND'), steer('first', '追加 FIRST')];
          send({ tool_calls: [{ index: 0, id: 'bash1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 0.3' }) } }] });
          send({}, 'tool_calls');
        } else if (sandboxCommand) {
          send({ tool_calls: [{ index: 0, id: 'sandbox-check', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: sandboxCommand }) } }] });
          sandboxCommand = undefined; send({}, 'tool_calls');
        } else { send({ content: 'native-ok' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
      }, 250);
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = model.address() as { port: number };
    await writeFile(path.join(home, 'config.toml'), `default_model = "smoke/smoke"\n[providers.smoke]\nbase_url = "http://127.0.0.1:${port}/v1"\ntype = "openai"\napi_key = "test"\n[models."smoke/smoke"]\nprovider = "smoke"\nmodel = "smoke"\nmax_context_size = 128000\ncapabilities = ["thinking"]\n`);
    const config = {
      timeout: 30000, workingDirectory: dir, permissionProfile: 'full_access',
      streamCallbacks: {
        onSteeringReady: (callback: HarnessSteer) => { registrations++; steer = callback; return () => { releases++; steer = undefined; }; },
        onStdoutChunk: (text: string, info?: { phase?: string | null }) => { progress.push({ text, phase: info?.phase }); },
        onToolEvent: () => { tools++; },
      },
    };
    const startedAt = Date.now();
    const first = await executeKimiCodeTask({ id: 'native', name: 'native test' }, { ...config, prompt: 'ORIGINAL' });
    if (!first.success) console.log({ dir, requests, progress, error: first.error });
    assert.equal(first.success, true, first.error); assert.equal(first.output, 'native-ok'); assert.ok(first.sessionId);
    const telemetry = await collectKimiCodeSessionTelemetry({ sessionId: first.sessionId!, executionId: 'native', startedAt, completedAt: Date.now(), home });
    assert.ok(telemetry?.runtimeState?.model);
    assert.equal(telemetry?.contextUsage?.totalTokens, 246);
    assert.equal(telemetry?.contextUsage?.contextWindow, 128000);
    assert.ok((await readKimiSessionBytes(first.sessionId!, home))!.bytes > 0);
    assert.deepEqual(await Promise.all(receipts), ['accepted', 'accepted', 'accepted']);
    assert.ok(tools >= 2, 'native Bash start and completion');
    assert.ok(progress.some(event => event.phase === 'reasoning_summary'));
    assert.ok(progress.some(event => event.phase === 'final_answer' && event.text === 'native-ok'));
    assert.ok(!JSON.stringify(progress).includes('PRIVATE_REASONING'));
    const last = JSON.parse(histories.at(-1)!);
    const users = last.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: unknown }) => JSON.stringify(m.content)).join('\n');
    assert.equal(users.split('FIRST').length - 1, 1); assert.equal(users.split('SECOND').length - 1, 1);
    const second = await executeKimiCodeTask({ id: 'native', name: 'resume test' }, { ...config, sessionId: first.sessionId, prompt: 'CONTINUATION' });
    assert.equal(second.success, true, second.error); assert.equal(second.sessionId, first.sessionId);
    assert.match(histories.at(-1)!, /FIRST/); assert.match(histories.at(-1)!, /CONTINUATION/);
    assert.equal(registrations, 2); assert.equal(releases, 2);
    process.env.KIMI_CODE_TRANSPORT = 'print';
    const legacy = await executeKimiCodeTask({ id: 'native', name: 'rollback test' }, { ...config, sessionId: first.sessionId, prompt: 'LEGACY' });
    assert.equal(legacy.success, true, legacy.error); assert.match(histories.at(-1)!, /FIRST/);
    delete process.env.KIMI_CODE_TRANSPORT;
    const restored = await executeKimiCodeTask({ id: 'native', name: 'restore test' }, { ...config, sessionId: legacy.sessionId, prompt: 'RESTORED' });
    assert.equal(restored.success, true, restored.error); assert.match(histories.at(-1)!, /LEGACY/);
    const workspace = path.join(dir, 'workspace'); await mkdir(workspace);
    sandboxCommand = `test ! -e '${dir}/outside-secret' && ! touch '${workspace}/forbidden' && echo SANDBOX_CONFIRMED`;
    await writeFile(path.join(dir, 'outside-secret'), 'not mounted');
    const restricted = await executeKimiCodeTask({ id: 'native', name: 'sandbox test' }, {
      ...config, workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'enabled', permissionProfile: 'safe_local', prompt: 'SANDBOX',
    });
    assert.equal(restricted.success, true, restricted.error);
    const toolResults = JSON.parse(histories.at(-1)!).messages.filter((m: { role: string }) => m.role === 'tool');
    assert.match(JSON.stringify(toolResults), /SANDBOX_CONFIRMED/);
    const sandboxResume = await executeKimiCodeTask({ id: 'native', name: 'sandbox resume test' }, {
      ...config, workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'enabled', permissionProfile: 'safe_local', sessionId: restricted.sessionId, prompt: 'SANDBOX CONTINUATION',
    });
    assert.equal(sandboxResume.success, true, sandboxResume.error);
    assert.equal(sandboxResume.sessionId, restricted.sessionId);
    assert.equal(registrations, releases);
    const emptyHome = path.join(dir, 'empty-home'); await mkdir(emptyHome);
    process.env.KIMI_CODE_HOME = emptyHome;
    const offline = await executeKimiCodeTask({ id: 'native', name: 'network namespace test' }, {
      ...config, workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', networkAccess: 'restricted', permissionProfile: 'safe_local', prompt: 'OFFLINE',
    });
    assert.equal(offline.success, false);
    assert.match(offline.error!, /no configured default model/); // Reached authenticated HTTP through isolated loopback.
    process.env.KIMI_CODE_HOME = home;
    console.log(`Native Kimi passed: thought status, Bash, two steering messages exactly once, same-session continuation, print rollback, sandbox read/write isolation (${requests} model calls)`);
  } finally {
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    for (const [key, value] of Object.entries({ KIMI_CODE_CLI_PATH: previous.binary, KIMI_CODE_HOME: previous.home, KIMI_CODE_TRANSPORT: previous.transport })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (!process.env.KIMI_NATIVE_KEEP) await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
