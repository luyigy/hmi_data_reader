// Opt-in: actual installed Codex, isolated home, new + resumed turns through both transports.
// Default uses a loopback provider; CODEX_RUNTIME_LIVE=1 uses the configured real provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import type { HarnessExecutionContext } from '../src/lib/harness/types';
import { prepareCodexHome } from '../src/lib/real-agents/codex-home';

async function main() {
  if (!process.env.CODEX_RUNTIME_NATIVE && !process.env.CODEX_RUNTIME_LIVE) {
    console.log('Skip native Codex runtime: set CODEX_RUNTIME_NATIVE=1 (loopback) or CODEX_RUNTIME_LIVE=1 (real provider)');
    return;
  }
  const live = process.env.CODEX_RUNTIME_LIVE === '1';
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-runtime-native-'));
  const requests: Array<{ model: string; reasoning?: { effort?: string } }> = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const id = `response-${requests.length}`;
      const item = { id: `msg-${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } } });
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const summary: object[] = [];
  try {
    if (!live) {
      const port = (server.address() as { port: number }).port;
      await writeFile(path.join(dir, 'config.toml'), `model = "gpt-5.4"
model_reasoning_effort = "medium"
model_provider = "fixture"
[features]
code_mode = false
[model_providers.fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
    }
    prepareCodexHome(dir);
    const task = { id: 'runtime-probe', name: 'Reply exactly OK. Do not use tools, inspect files, or change anything.' };
    for (const transport of ['app-server', 'exec-json']) {
      let sessionId = '';
      let previousTurn = '';
      for (const resume of [false, true]) {
        const ctx: HarnessExecutionContext = {
          executionId: `${transport}-${resume}`, workingDirectory: dir, codexHome: dir,
          executionBackend: 'platform_local', timeout: 90_000,
          ...(process.env.CODEX_RUNTIME_BWRAP ? { workspaceRoot: dir, networkAccess: 'enabled' as const } : {}),
          permissionConfig: { profile: 'custom', sandboxMode: 'read-only', approvalPolicy: 'never',
            networkAccess: 'enabled', writableRoots: [] },
          ...(resume ? { reasoningEffort: 'low', ...(!live ? { model: 'gpt-5.4-mini' } : {}) } : {}),
          ...(transport === 'app-server' ? { streamCallbacks: { onSteeringReady: () => () => {} } } : {}),
        };
        const result = await (resume ? codexHarnessAdapter.resume!({ task, context: ctx, sessionId,
          continuationMessage: task.name }) : codexHarnessAdapter.execute({ task, context: ctx }));
        assert.equal(result.success, true, result.error);
        assert.ok(result.runtimeState, `${transport} resume=${resume}: missing evidence`);
        assert.ok(result.contextUsage, `${transport} resume=${resume}: missing context usage`);
        assert.equal(result.contextUsage.sessionId, result.sessionId);
        assert.match(result.output!, /OK/);
        if (resume) assert.equal(result.sessionId, sessionId);
        assert.notEqual(result.runtimeState.turnId, previousTurn);
        sessionId = result.sessionId!;
        previousTurn = result.runtimeState.turnId!;
        const files = await readdir(path.join(dir, 'sessions'), { recursive: true });
        const file = files.find(name => name.endsWith(`-${sessionId}.jsonl`))!;
        const raw = (await readFile(path.join(dir, 'sessions', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
          .filter(e => e.type === 'turn_context' && e.payload.turn_id === previousTurn).at(-1);
        assert.equal(result.runtimeState.model, raw.payload.model);
        assert.equal(result.runtimeState.observedAt, Date.parse(raw.timestamp));
        assert.deepEqual(result.runtimeState.reasoning, { kind: 'level', value: raw.payload.effort });
        if (resume) assert.equal(raw.payload.effort, 'low');
        if (!live) {
          assert.equal(result.runtimeState.model, requests.at(-1)!.model);
          assert.equal(raw.payload.effort, requests.at(-1)!.reasoning!.effort);
        }
        summary.push({ transport, resume, sessionId, turnId: previousTurn, model: raw.payload.model,
          effort: raw.payload.effort, observedAt: raw.timestamp, rawEvidenceMatches: true, output: result.output });
      }
      if (!live) {
        const ephemeral = await codexHarnessAdapter.execute({ task, context: {
          executionId: `${transport}-ephemeral`, workingDirectory: dir, codexHome: dir,
          executionBackend: 'platform_local', timeout: 90_000, ephemeralSession: true,
          ...(transport === 'app-server' ? { streamCallbacks: { onSteeringReady: () => () => {} } } : {}),
        } });
        assert.equal(ephemeral.success, true, ephemeral.error);
        assert.equal(ephemeral.runtimeState, undefined);
      }
    }
    const report = { version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      provider: live ? 'real configured provider' : 'loopback fixture', bubblewrap: Boolean(process.env.CODEX_RUNTIME_BWRAP), summary };
    if (process.env.CODEX_RUNTIME_REPORT) await writeFile(process.env.CODEX_RUNTIME_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
