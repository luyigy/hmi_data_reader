import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseAntigravityRuntimeState,
  collectAntigravityRuntimeState,
  getAntigravityExecutionLogPath,
} from '../src/lib/real-agents/antigravity-runtime-state';
import { antigravityHarnessAdapter } from '../src/lib/harness/adapters/antigravity';
import {
  beginHarnessRuntimeExecution,
  persistHarnessRuntimeState,
} from '../src/lib/harness-runtime-state';
import { buildLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

function formatLogTimestamp(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const H = pad(date.getHours());
  const M = pad(date.getMinutes());
  const S = pad(date.getSeconds());
  const us = pad(date.getMilliseconds() * 1000, 6);
  return `I${m}${d} ${H}:${M}:${S}.${us}`;
}

async function main() {
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const now = Date.now();
  const startedAt = now - 5000;
  const completedAt = now;
  const scope = {
    executionId: 'exec-1',
    sessionId,
    startedAt,
    completedAt,
  };

  const ts = formatLogTimestamp(new Date(now - 2000));
  const fixtureWithResolver = [
    `${ts} 1 printmode.go:202] Print mode: starting (promptLength=10, model="", conversationID="")`,
    `${ts} 1 model_resolver.go:93] Resolving model gemini-3.8-flash-low`,
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.8 Flash (Low)"`,
    `${ts} 1 server.go:1248] Created conversation ${sessionId}`,
    `${ts} 1 server.go:1810] Sending user message to conversation ${sessionId} (items=1, media=0)`,
  ];

  // 1. Basic parsing with resolver & label
  const state1 = await parseAntigravityRuntimeState(fixtureWithResolver, scope);
  assert.ok(state1, 'state1 should be defined');
  assert.equal(state1.executionId, 'exec-1');
  assert.equal(state1.sessionId, sessionId);
  assert.equal(state1.model, 'gemini-3.8-flash-low');
  assert.equal(state1.modelKind, 'model_id');
  assert.deepEqual(state1.reasoning, { kind: 'level', value: 'low' });
  assert.equal(state1.evidence, 'runner');
  assert.equal(state1.source, 'antigravity_cli.log');

  // 2. Default model when resolver is omitted but label is Gemini 3.8 Flash (High)
  const fixtureDefault = [
    `${ts} 1 printmode.go:202] Print mode: starting (promptLength=10, model="", conversationID="")`,
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"`,
    `${ts} 1 server.go:1248] Created conversation ${sessionId}`,
    `${ts} 1 server.go:1810] Sending user message to conversation ${sessionId} (items=1, media=0)`,
  ];
  const state2 = await parseAntigravityRuntimeState(fixtureDefault, scope);
  assert.ok(state2, 'state2 should be defined');
  assert.equal(state2.model, 'gemini-3.8-flash-high');
  assert.equal(state2.modelKind, 'model_id');
  assert.deepEqual(state2.reasoning, { kind: 'level', value: 'high' });

  // 3. Custom/unknown label with effort suffix
  const fixtureCustom = [
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Custom FineTune (Medium)"`,
    `${ts} 1 server.go:1248] Created conversation ${sessionId}`,
  ];
  const state3 = await parseAntigravityRuntimeState(fixtureCustom, scope);
  assert.ok(state3, 'state3 should be defined');
  assert.equal(state3.model, 'Custom FineTune (Medium)');
  assert.equal(state3.modelKind, 'alias');
  assert.deepEqual(state3.reasoning, { kind: 'level', value: 'medium' });

  // 4. Thinking model label
  const fixtureThinking = [
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Claude Sonnet 4.6 (Thinking)"`,
    `${ts} 1 server.go:1248] Created conversation ${sessionId}`,
  ];
  const state4 = await parseAntigravityRuntimeState(fixtureThinking, scope);
  assert.ok(state4, 'state4 should be defined');
  assert.equal(state4.model, 'claude-sonnet-4-6');
  assert.equal(state4.modelKind, 'model_id');
  assert.deepEqual(state4.reasoning, { kind: 'level', value: 'thinking' });

  // 5. Unknown effort when no suffix or keyword matches
  const fixtureNoEffort = [
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Generic Model"`,
    `${ts} 1 server.go:1248] Created conversation ${sessionId}`,
  ];
  const state5 = await parseAntigravityRuntimeState(fixtureNoEffort, scope);
  assert.ok(state5, 'state5 should be defined');
  assert.deepEqual(state5.reasoning, { kind: 'unknown' });

  // 6. Resumed conversation matching
  const fixtureResumed = [
    `${ts} 1 session.go:154] Print mode: resuming conversation ${sessionId}`,
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.7 Flash (Medium)"`,
    `${ts} 1 server.go:1810] Sending user message to conversation ${sessionId} (items=1, media=0)`,
  ];
  const stateResumed = await parseAntigravityRuntimeState(fixtureResumed, scope);
  assert.ok(stateResumed, 'stateResumed should be defined');
  assert.equal(stateResumed.model, 'gemini-3.7-flash-medium');
  assert.deepEqual(stateResumed.reasoning, { kind: 'level', value: 'medium' });

  // 7. Isolation: session mismatch must be rejected
  const otherSession = '99999999-8888-7777-6666-555555555555';
  const fixtureMismatch = [
    `${ts} 1 server.go:1248] Created conversation ${otherSession}`,
    `${ts} 1 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"`,
  ];
  const stateMismatch = await parseAntigravityRuntimeState(fixtureMismatch, scope);
  assert.equal(stateMismatch, undefined, 'Mismatched session ID must be rejected');

  // 8. Missing required scope fields
  assert.equal(await parseAntigravityRuntimeState(fixtureDefault, { ...scope, executionId: undefined }), undefined);
  assert.equal(await parseAntigravityRuntimeState(fixtureDefault, { ...scope, sessionId: undefined }), undefined);

  // 9. Fallback to initModel when lines are empty
  const stateFallback = await parseAntigravityRuntimeState([], {
    ...scope,
    initModel: 'gemini-3.7-flash-high',
  });
  assert.ok(stateFallback, 'Fallback state should exist');
  assert.equal(stateFallback.model, 'gemini-3.7-flash-high');
  assert.deepEqual(stateFallback.reasoning, { kind: 'level', value: 'high' });
  assert.equal(stateFallback.source, 'antigravity_init');

  // 10. File reading and collectAntigravityRuntimeState
  const tempDir = await mkdtemp(path.join(tmpdir(), 'agy-runtime-test-'));
  const logFile = path.join(tempDir, 'exec-1.log');
  await writeFile(logFile, fixtureWithResolver.join('\n'));

  const collected = await collectAntigravityRuntimeState({
    ...scope,
    logFile,
  });
  assert.deepEqual(collected, state1);

  // Non-existent file gracefully falls back or returns undefined
  const collectedMissing = await collectAntigravityRuntimeState({
    ...scope,
    logFile: path.join(tempDir, 'non-existent.log'),
  });
  assert.equal(collectedMissing, undefined);

  // Fallback to initModel if logFile is missing
  const collectedFallback = await collectAntigravityRuntimeState({
    ...scope,
    logFile: path.join(tempDir, 'non-existent.log'),
    initModel: 'gemini-3.8-flash-low',
  });
  assert.ok(collectedFallback);
  assert.equal(collectedFallback.model, 'gemini-3.8-flash-low');

  // 11. Harness Adapter integration and Footnotes formatting
  const agentModule = require('../src/lib/real-agents/antigravity-agent');
  const originalExecute = agentModule.executeAntigravityTask;

  try {
    const execution = await beginHarnessRuntimeExecution('participant-agy');
    const execObservedAt = execution.startedAt + 500;
    const execCompletedAt = execution.startedAt + 1000;
    const testState = {
      ...state1,
      executionId: execution.id,
      observedAt: execObservedAt,
    };

    agentModule.executeAntigravityTask = async () => ({
      success: true,
      sessionId,
      output: 'All tasks completed.',
      executionTime: 1200,
      contextUsage: {
        lastRunInputTokens: 15400,
        outputTokens: 45,
        contextWindow: 1048576,
        updatedAt: new Date(execCompletedAt).toISOString(),
        modelAlias: 'gemini-3.8-flash-high',
        confidence: 'measured_exact',
      },
      runtimeState: testState,
    });

    const context: HarnessExecutionContext = {
      executionId: execution.id,
      workingDirectory: tempDir,
      executionBackend: 'platform_local',
      timeout: 5000,
      model: 'requested-model',
      reasoningEffort: 'low',
    };

    const runResult = await antigravityHarnessAdapter.execute({
      task: { id: 'task-1', name: 'task-1' },
      context,
    });

    assert.equal(runResult.success, true);
    assert.deepEqual(runResult.runtimeState, testState);
    assert.equal(runResult.contextUsage?.usedTokens, 15400);

    // Verify metadata persistence and footnote generation
    const metadata = JSON.stringify({
      lastSessionId: sessionId,
      runtimeExecution: {
        ...execution,
        completedAt: execCompletedAt,
      },
      runtimeState: testState,
      contextUsage: runResult.contextUsage,
    });

    const footnotes = buildLiveRoomFootnotes({
      metadata,
      participantId: 'participant-agy',
      model: 'requested-model',
      reasoningEffort: 'low',
      startedAt: execution.startedAt,
      now: execCompletedAt,
    });

    const footnoteText = footnotes.join('\n');
    assert.match(footnoteText, /模型：gemini-3.8-flash-low · 思考档位：low · 运行器报告 \/ antigravity_cli.log/);
    assert.match(footnoteText, /本轮请求：requested-model · low/);
    assert.match(footnoteText, /本轮输入 15,400 \/ 输出 45 tokens/);

    // 12. Token absence must not lose runtime state
    const footnotesNoTokens = buildLiveRoomFootnotes({
      metadata: JSON.stringify({
        lastSessionId: sessionId,
        runtimeExecution: {
          ...execution,
          completedAt: execCompletedAt,
        },
        runtimeState: testState,
      }),
      participantId: 'participant-agy',
      startedAt: execution.startedAt,
      now: execCompletedAt,
    });
    const footnoteTextNoTokens = footnotesNoTokens.join('\n');
    assert.match(footnoteTextNoTokens, /模型：gemini-3.8-flash-low · 思考档位：low · 运行器报告 \/ antigravity_cli.log/);
    assert.match(footnoteTextNoTokens, /本轮 token 用量未提供/);

    // 13. Resumed turn in adapter
    agentModule.executeAntigravityTask = async () => ({
      success: true,
      sessionId,
      output: 'Resumed output',
      executionTime: 800,
      runtimeState: stateResumed,
    });

    const resumedResult = await antigravityHarnessAdapter.resume!({
      task: { id: 'task-1', name: 'task-1' },
      sessionId,
      continuationMessage: 'continue',
      context,
    });
    assert.equal(resumedResult.success, true);
    assert.deepEqual(resumedResult.runtimeState, stateResumed);
  } finally {
    agentModule.executeAntigravityTask = originalExecute;
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log('Antigravity runtime state: resolver, labels, fallback, session isolation, adapter, tokens-independence and footnotes passed');
}

void main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
