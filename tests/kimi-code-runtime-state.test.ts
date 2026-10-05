import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseKimiCodeSessionTelemetry } from '../src/lib/real-agents/kimi-code-context';
import { collectKimiCodeSessionTelemetry } from '../src/lib/real-agents/kimi-code-telemetry';
import { formatHarnessRuntimeState } from '../src/lib/harness-runtime-state';

const line = (value: object) => JSON.stringify(value);
const request = (time: number, model = 'k3', thinkingEffort: unknown = 'high') =>
  line({ type: 'llm.request', agentId: 'main', time, model, modelAlias: 'kimi-code/k3', thinkingEffort });
const wire = [
  line({ type: 'turn.prompt', agentId: 'main', time: 100 }),
  request(110, 'old'),
  line({ type: 'context.append_loop_event', agentId: 'main', time: 115,
    event: { type: 'step.end', usage: { inputCacheRead: 5, inputCacheCreation: 0, inputOther: 3, output: 2 } } }),
  line({ type: 'turn.ended', agentId: 'main', time: 120, turnId: 0, reason: 'completed' }),
  'damaged json',
  line({ type: 'turn.prompt', agentId: 'main', time: 200 }),
  request(210, 'k3', 'high'),
  line({ type: 'context.append_loop_event', agentId: 'main', time: 220,
    event: { type: 'step.end', usage: { inputCacheRead: 20, inputCacheCreation: 0, inputOther: 8, output: 2 } } }),
  line({ type: 'turn.ended', agentId: 'main', time: 230, turnId: 1, reason: 'completed' }),
].join('\n');
const scope = { executionId: 'exec', sessionId: 'session-1', startedAt: 190, completedAt: 240 };
assert.deepEqual(parseKimiCodeSessionTelemetry(wire, scope), {
  runtimeState: { executionId: 'exec', sessionId: 'session-1', turnId: '1',
    model: 'k3', modelKind: 'model_id', reasoning: { kind: 'level', value: 'high' },
    source: 'kimi_wire.llm.request', evidence: 'runner', observedAt: 210 },
  contextUsage: { usedTokens: 30, totalTokens: 40, metricKind: 'session_context', confidence: 'assumed_window',
    sessionId: 'session-1', collectedAt: 230, model: 'k3' },
  modelAlias: 'kimi-code/k3',
});
assert.equal(parseKimiCodeSessionTelemetry(wire, { ...scope, startedAt: 235 }), undefined);
assert.equal(parseKimiCodeSessionTelemetry(wire.replace('"reason":"completed"}', '"reason":"interrupted"}'),
  { ...scope, startedAt: 90, completedAt: 125 }), undefined);
assert.equal(parseKimiCodeSessionTelemetry(wire.replace('"type":"turn.ended","agentId":"main","time":230',
  '"type":"other","agentId":"main","time":230'), scope), undefined);
assert.deepEqual(parseKimiCodeSessionTelemetry([
  line({ type: 'turn.prompt', time: 200 }), request(210, 'k3', null),
  line({ type: 'turn.ended', time: 230, turnId: 1, reason: 'completed' }),
].join('\n'), scope)?.runtimeState.reasoning, { kind: 'unknown' });
const switched = parseKimiCodeSessionTelemetry([
  line({ type: 'turn.prompt', time: 200 }), request(205, 'old', 'high'),
  request(210, 'k3-256k', 'off'),
  line({ type: 'turn.ended', time: 230, turnId: 1, reason: 'completed' }),
].join('\n'), scope);
assert.equal(switched?.runtimeState.model, 'k3-256k');
assert.deepEqual(switched?.runtimeState.reasoning, { kind: 'toggle', enabled: false });
assert.equal(switched?.contextUsage, undefined);
assert.match(formatHarnessRuntimeState(switched!.runtimeState), /k3-256k.*思考开关：关闭/);

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-state-'));
  try {
    const dir = path.join(home, 'sessions', 'workspace', 'session_session-1', 'agents', 'main');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'wire.jsonl'), wire);
    const noConfig = await collectKimiCodeSessionTelemetry({ ...scope, home });
    assert.equal(noConfig?.runtimeState.model, 'k3');
    assert.equal(noConfig?.contextUsage?.contextWindow, undefined);
    await writeFile(path.join(home, 'config.toml'), '[models."kimi-code/k3"]\nmax_context_size = 1000\n');
    const configured = await collectKimiCodeSessionTelemetry({ ...scope, home });
    assert.equal(configured?.contextUsage?.contextWindow, 1000);
    assert.equal(configured?.contextUsage?.confidence, 'assumed_window');
    assert.equal((await collectKimiCodeSessionTelemetry({ ...scope, startedAt: 235, home })), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
  console.log('kimi code runtime state tests passed');
}
void main();
