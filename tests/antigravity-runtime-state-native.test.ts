import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

async function main() {
  const runNative = Boolean(process.env.ANTIGRAVITY_RUNTIME_NATIVE_TEST);
  if (!runNative) {
    console.log('Skip native Antigravity runtime: set ANTIGRAVITY_RUNTIME_NATIVE_TEST=1');
    return;
  }

  const { antigravityHarnessAdapter: adapter } = await import('../src/lib/harness/adapters/antigravity');
  const availability = await adapter.checkAvailability();
  if (!availability.available) {
    console.log('Skip native Antigravity runtime: CLI not available');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'agy-native-runtime-'));
  try {
    const task = { id: 'smoke', name: 'smoke', description: 'Reply only OK. Do not use tools.' };
    const context: HarnessExecutionContext = {
      executionId: 'native-agy-test-1',
      workingDirectory: root,
      executionBackend: 'platform_local',
      timeout: 30000,
    };

    // 1. First turn: create new conversation
    const first = await adapter.execute({ task, context });
    assert.equal(first.success, true, first.error);
    assert.ok(first.sessionId, 'First turn must return a sessionId');
    assert.ok(first.runtimeState, 'First turn must return runtimeState');
    assert.equal(first.runtimeState.evidence, 'runner');
    assert.equal(first.runtimeState.sessionId, first.sessionId);
    assert.ok(first.runtimeState.model, 'Runtime model must be detected');
    assert.ok(first.runtimeState.reasoning, 'Reasoning state must be present');
    console.log(`Native Antigravity first turn: model=${first.runtimeState.model}, reasoning=${JSON.stringify(first.runtimeState.reasoning)}`);

    // 2. Second turn: resume conversation with explicit effort
    const resumed = await adapter.resume!({
      task,
      sessionId: first.sessionId,
      continuationMessage: 'Reply only OK.',
      context: {
        ...context,
        executionId: 'native-agy-test-2',
        reasoningEffort: 'low',
      },
    });
    assert.equal(resumed.success, true, resumed.error);
    assert.equal(resumed.sessionId, first.sessionId);
    assert.ok(resumed.runtimeState, 'Resumed turn must return runtimeState');
    assert.equal(resumed.runtimeState.sessionId, first.sessionId);
    assert.equal(resumed.runtimeState.executionId, 'native-agy-test-2');
    console.log(`Native Antigravity resumed turn: model=${resumed.runtimeState.model}, reasoning=${JSON.stringify(resumed.runtimeState.reasoning)}`);

    console.log('Native Antigravity new/resume runtime telemetry passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
