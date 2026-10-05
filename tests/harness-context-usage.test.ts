import assert from 'node:assert/strict';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import { kimiCodeHarnessAdapter } from '../src/lib/harness/adapters/kimi-code';
import { antigravityHarnessAdapter } from '../src/lib/harness/adapters/antigravity';
import type { HarnessExecutionContext, NormalizedContextUsage } from '../src/lib/harness/types';

async function main() {
  // Replace native execution only: exercise the actual adapter boundary without launching CLIs.
  const codex = require('../src/lib/real-agents/codex-agent');
  const kimi = require('../src/lib/real-agents/kimi-code-agent');
  const telemetry = require('../src/lib/real-agents/kimi-code-telemetry');
  const antigravity = require('../src/lib/real-agents/antigravity-agent');
  const originals = [codex.executeCodexTask, codex.resumeCodexSession, kimi.executeKimiCodeTask,
    telemetry.collectKimiCodeSessionTelemetry, antigravity.executeAntigravityTask];
  let started = '';
  let streamed: NormalizedContextUsage | undefined;
  const context: HarnessExecutionContext = {
    workingDirectory: process.cwd(), executionBackend: 'platform_local', executionId: 'execution', timeout: 1000,
    onSessionStarted: session => { started = session.sessionId; },
    onContextUsage: usage => { assert.equal(started, usage.sessionId); streamed = usage; },
  };
  const task = { id: 'test', name: 'test' };
  const now = new Date().toISOString();
  const nativeCodex = async (options: {
    onThreadStarted: (id: string) => Promise<void>;
    streamCallbacks: { onCodexTokenUsage: (usage: unknown) => Promise<void> };
  }) => {
    await options.onThreadStarted('codex');
    await options.streamCallbacks.onCodexTokenUsage({
      threadId: 'codex', collectedAt: now, last: { inputTokens: 85, outputTokens: 7 },
      total: { inputTokens: 9000, totalTokens: 9007 }, modelContextWindow: 100,
    });
    return { success: true, threadId: 'codex', executionTime: 1 };
  };
  codex.executeCodexTask = (_task: unknown, options: Parameters<typeof nativeCodex>[0]) => nativeCodex(options);
  codex.resumeCodexSession = nativeCodex;
  kimi.executeKimiCodeTask = async () => ({ success: true, sessionId: 'kimi', executionTime: 1 });
  telemetry.collectKimiCodeSessionTelemetry = async () => {
    assert.equal(started, 'kimi', 'session must be persisted before telemetry is returned');
    return { contextUsage: { usedTokens: 85, contextWindow: 100, collectedAt: Date.parse(now),
      sessionId: 'kimi', metricKind: 'session_context', confidence: 'assumed_window', model: 'kimi-model' } };
  };
  antigravity.executeAntigravityTask = async (_task: unknown, options: {
    onSessionStarted: (id: string) => Promise<void>;
  }) => {
    await options.onSessionStarted('agy');
    return { success: true, sessionId: 'agy', executionTime: 1,
      contextUsage: { lastRunInputTokens: 85, contextWindow: 100, outputTokens: 7, modelAlias: 'agy-model',
        confidence: 'measured_exact', updatedAt: now } };
  };
  try {
    for (const adapter of [codexHarnessAdapter, kimiCodeHarnessAdapter, antigravityHarnessAdapter]) {
      for (const resume of [false, true]) {
        started = '';
        const args = { task, context, sessionId: 'previous', continuationMessage: 'continue' };
        const result = await (resume ? adapter.resume!(args) : adapter.execute(args));
        assert.equal(result.contextUsage?.usedTokens, 85);
        assert.equal(result.contextUsage?.contextWindow, 100);
        assert.equal(result.contextUsage?.sessionId, started);
        if (adapter === antigravityHarnessAdapter) assert.equal(result.contextUsage?.metricKind, 'cumulative');
        assert.equal(result.contextUsage?.confidence, adapter === kimiCodeHarnessAdapter ? 'assumed_window' : 'measured_exact');
        if (adapter === codexHarnessAdapter) assert.deepEqual(result.contextUsage, streamed);
        if (adapter === codexHarnessAdapter) assert.equal(result.contextUsage?.totalTokens, 9007);
        assert.equal(result.contextUsage?.outputTokens, adapter === kimiCodeHarnessAdapter ? undefined : 7);
        assert.equal(result.contextUsage?.model, adapter === kimiCodeHarnessAdapter ? 'kimi-model' : adapter === antigravityHarnessAdapter ? 'agy-model' : undefined);
      }
    }
  } finally {
    [codex.executeCodexTask, codex.resumeCodexSession, kimi.executeKimiCodeTask,
      telemetry.collectKimiCodeSessionTelemetry, antigravity.executeAntigravityTask] = originals;
  }
  console.log('harness context usage tests passed (execute + resume, all three adapters)');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
