import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

async function main() {
  const binary = process.env.PI_RUNTIME_NATIVE_BIN;
  if (!binary) { console.log('Skip native Pi runtime: set PI_RUNTIME_NATIVE_BIN'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'pi-runtime-native-'));
  const previous = { bin: process.env.PI_AGENT_BIN, sessions: process.env.PI_AGENT_SESSION_ROOT,
    agentDir: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_AGENT_BIN = binary;
  process.env.PI_AGENT_SESSION_ROOT = path.join(root, 'sessions');
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'config');
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', created: 1,
        model: 'smoke', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', created: 1,
        model: 'smoke', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    const address = server.address() as { port: number };
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, 'models.json'), JSON.stringify({ providers: {
      'ap-smoke': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
        apiKey: 'test', models: [{ id: 'smoke' }] },
    } }));
    const { piAgentHarnessAdapter: adapter } = await import('../src/lib/harness/adapters/pi-agent');
    const context: HarnessExecutionContext = { executionId: 'native-execution', workingDirectory: root,
      executionBackend: 'platform_local', timeout: 20_000, sessionKey: 'native',
      model: 'ap-smoke/smoke', reasoningEffort: 'off' };
    const task = { id: 'native', name: 'Reply only OK. Do not use tools.' };
    for (const transport of ['json', 'rpc']) {
      const runContext = { ...context, sessionKey: `native-${transport}`,
        ...(transport === 'rpc' ? { streamCallbacks: { onSteeringReady: () => () => {} } } : {}) };
      const first = await adapter.execute({ task, context: runContext });
      assert.equal(first.success, true, first.error);
      assert.equal(first.runtimeState?.model, 'smoke', transport);
      assert.equal(first.runtimeState?.provider, 'ap-smoke');
      assert.deepEqual(first.runtimeState?.reasoning, { kind: 'level', value: 'off' });
      const second = await adapter.resume!({ task, sessionId: first.sessionId!, continuationMessage: 'Reply only OK.',
        context: { ...runContext, executionId: `native-${transport}-resume` } });
      assert.equal(second.success, true, second.error);
      assert.equal(second.runtimeState?.model, 'smoke', transport);
      assert.equal(second.runtimeState?.sessionId, first.sessionId);
      assert.notEqual(second.runtimeState?.turnId, first.runtimeState?.turnId);
    }
    assert.ok(calls >= 4);
    console.log('Native Pi JSON/RPC new/resume runtime evidence passed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous.bin === undefined) delete process.env.PI_AGENT_BIN; else process.env.PI_AGENT_BIN = previous.bin;
    if (previous.sessions === undefined) delete process.env.PI_AGENT_SESSION_ROOT; else process.env.PI_AGENT_SESSION_ROOT = previous.sessions;
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
