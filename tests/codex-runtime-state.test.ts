import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectCodexRuntimeState, parseCodexRuntimeState, parseCodexTelemetry } from '../src/lib/real-agents/codex-runtime-state';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import { beginHarnessRuntimeExecution, persistHarnessRuntimeState } from '../src/lib/harness-runtime-state';
import { collectLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import { prisma } from '../src/lib/prisma';
import type { HarnessExecutionContext } from '../src/lib/harness/types';
import { applyWorkflowPermissionSnapshot, buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';

// Sanitized codex-cli 0.153.2 rollout record shapes; no request settings are evidence.
const threadId = '01a0f740-2410-73d1-bda3-8b28eaec7417';
const event = (type: string, payload: object, at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
const meta = (id = threadId) => event('session_meta', { id, model_provider: 'old-thread-provider' }, 0);
const start = (at: number, turn_id = 'turn') => event('event_msg', { type: 'task_started', turn_id }, at);
const context = (at: number, values: object = {}) => event('turn_context', { turn_id: 'turn', model: 'runner-model', effort: 'high', ...values }, at);
const end = (at: number, turn_id = 'turn') => event('event_msg', { type: 'task_complete', turn_id }, at);

async function main() {
  const scope = { executionId: 'execution', threadId, startedAt: 100, completedAt: 1000 };
  const fixture = [meta(), start(101), context(102), end(103)];
  const state = await parseCodexRuntimeState(fixture, scope);
  assert.equal(state?.model, 'runner-model');
  assert.deepEqual(state?.reasoning, { kind: 'level', value: 'high' });
  assert.equal(state?.provider, undefined, 'old session provider is not current turn evidence');
  assert.equal(state?.observedAt, 102);
  for (const [lines, patch] of [
    [fixture, { executionId: undefined }], [fixture, { threadId: 'other-session' }],
    [fixture, { startedAt: 104 }], [fixture, { completedAt: 100 }], [fixture, { turnId: 'old-turn' }],
    [[meta(), context(102), end(103)], {}],
    [[meta(), start(101), context(102)], {}],
    [[...fixture, start(104, 'concurrent'), context(105, { turn_id: 'concurrent' }), end(106, 'concurrent')], {}],
    [[...fixture, '{broken'], {}], [[meta(), ...fixture], {}],
    [[meta(), start(101), context(102, { turn_id: 'other-turn' }), end(103)], {}],
    [[meta(), start(1), context(102), end(103)], {}],
    [[meta(), start(101), event('response_item', { type: 'turn_context', model: 'injected' }, 102), end(103)], {}],
  ] as const) assert.equal(await parseCodexRuntimeState(lines, { ...scope, ...patch }), undefined);
  assert.ok(await parseCodexRuntimeState(fixture.slice(0, -1), { ...scope, turnId: 'turn' }), 'app-server receipt binds the turn without requiring a flushed completion record');
  const changed = await parseCodexRuntimeState([...fixture.slice(0, -1), context(104, { model: 'new-model', effort: 'low' }), end(105)], scope);
  assert.equal(changed?.model, 'new-model');
  assert.deepEqual(changed?.reasoning, { kind: 'level', value: 'low' });
  const missing = await parseCodexRuntimeState([...fixture.slice(0, -1), context(104, { model: null, effort: null }), end(105)], scope);
  assert.equal(missing?.model, undefined);
  assert.deepEqual(missing?.reasoning, { kind: 'unknown' });
  assert.equal((await parseCodexRuntimeState([meta(), start(101), context(104), context(102, { model: 'late-old' }), end(105)], scope))?.model, 'runner-model');
  assert.equal((await parseCodexRuntimeState([meta(), start(101), context(102, { model: {} }), end(103)], scope))?.model, undefined);

  const usage = (at: number, window = 475000, type = 'event_msg') => event(type, {
    type: 'token_count', info: { last_token_usage: { input_tokens: 123, output_tokens: 7 }, model_context_window: window },
  }, at);
  assert.equal((await parseCodexTelemetry([meta(), start(101), usage(102), end(103)], scope))?.contextUsage?.usedTokens, 123);
  for (const lines of [[meta(), usage(100), start(101), end(103)],
    [meta(), start(101), end(103), usage(104)], [meta(), start(101), usage(102, -1), end(103)],
    [meta(), start(101), usage(102, 475000, 'response_item'), end(103)],
    [meta(), start(101), start(102, 'other'), usage(103), end(104), end(105, 'other')]]) {
    assert.equal((await parseCodexTelemetry(lines, scope))?.contextUsage, undefined, 'Unbound, malformed or ambiguous usage remains unknown');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'codex-runtime-'));
  const sessions = path.join(dir, 'sessions', '2026', '10', '01');
  const rollout = path.join(sessions, `rollout-2026-10-01T19-36-11-${threadId}.jsonl`);
  const native = require('../src/lib/real-agents/codex-agent');
  const originals = [native.executeCodexTask, native.resumeCodexSession,
    prisma.taskRunParticipant.findUnique, prisma.taskRunParticipant.updateMany];
  let stored: Record<string, any> = { unrelated: 'keep' };
  prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: JSON.stringify(stored) })) as any;
  prisma.taskRunParticipant.updateMany = (async ({ data }: any) => { stored = JSON.parse(data.controlMetadata); return { count: 1 }; }) as any;
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(rollout, fixture.join('\n'));
    assert.deepEqual(await collectCodexRuntimeState({ ...scope, codexHome: dir }), state);
    const padding = event('response_item', { type: 'message', content: 'x'.repeat(100_000) }, 0) + '\n';
    await writeFile(rollout, meta() + '\n' + padding.repeat(680) + fixture.slice(1).join('\n'));
    assert.equal((await collectCodexRuntimeState({ ...scope, codexHome: dir }))?.model, 'runner-model',
      'Large historical rollout must not hide the verified current turn');
    await writeFile(rollout, fixture.join('\n'));
    assert.equal(await collectCodexRuntimeState({ ...scope, codexHome: dir, ephemeral: true }), undefined);
    assert.equal(await collectCodexRuntimeState({ ...scope, codexHome: path.join(dir, 'missing') }), undefined);
    assert.equal(await collectCodexRuntimeState({ ...scope, codexHome: dir, threadId: '../escape' }), undefined);
    const duplicate = path.join(sessions, `rollout-duplicate-${threadId}.jsonl`);
    await writeFile(duplicate, fixture.join('\n'));
    assert.equal(await collectCodexRuntimeState({ ...scope, codexHome: dir }), undefined);
    await rm(duplicate);
    await rm(rollout);
    const outside = path.join(dir, 'outside.jsonl');
    await writeFile(outside, fixture.join('\n'));
    await symlink(outside, rollout);
    assert.equal(await collectCodexRuntimeState({ ...scope, codexHome: dir }), undefined);
    await rm(rollout);

    // Native result -> actual adapter collector -> metadata persistence -> actual public footnotes.
    // Old turn stays in the same file on resume; explicit settings differ from native evidence.
    for (const transport of ['app-server', 'exec-json', 'workflow-home']) {
      for (const resume of [false, true]) {
        const execution = await beginHarnessRuntimeExecution('participant');
        const invoke = async (options: any) => {
          const at = Date.now();
          const target = path.join(options.codexHome, 'sessions', '2026', '10', '01', path.basename(rollout));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, [...fixture, start(at, 'current'), context(at, {
            turn_id: 'current', model: resume ? 'native-resumed' : 'native-inherited', effort: resume ? 'low' : 'high',
          }), event('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 123, output_tokens: 7 }, model_context_window: 475000 } }, at), end(at, 'current')].join('\n'));
          await options.onThreadStarted(threadId);
          return { success: true, threadId, turnId: transport === 'app-server' ? 'current' : undefined,
            output: 'OK', executionTime: 1 };
        };
        native.executeCodexTask = (_: unknown, options: unknown) => invoke(options);
        native.resumeCodexSession = invoke;
        const ctx: HarnessExecutionContext = {
          executionId: execution.id, workingDirectory: dir, executionBackend: 'platform_local',
          codexHome: dir, timeout: 1000, model: 'requested-model', reasoningEffort: 'requested-effort',
          onSessionStarted: async session => { stored.lastSessionId = session.sessionId; },
        };
        if (transport === 'workflow-home') {
          const snapshot = buildWorkflowPermissionSnapshot({ policy: { preset: 'workspace' }, projectPath: dir, source: 'test' });
          ctx.permissionConfig = applyWorkflowPermissionSnapshot(snapshot.effective.permissionConfig, snapshot);
          ctx.codexHome = path.join(dir, 'unmounted-requested-home');
        }
        const args = { task: { id: 'test', name: 'test' }, context: ctx, sessionId: threadId, continuationMessage: 'continue' };
        const result = await (resume ? codexHarnessAdapter.resume!(args) : codexHarnessAdapter.execute(args));
        assert.equal(result.success, true);
        assert.equal(result.contextUsage?.usedTokens, 123, 'exec JSON must recover actual usage from the same native turn');
        assert.equal(result.runtimeState?.model, resume ? 'native-resumed' : 'native-inherited');
        await persistHarnessRuntimeState(execution, result.runtimeState);
        assert.equal(stored.unrelated, 'keep');
        const notes = await collectLiveRoomFootnotes({ participantId: 'participant', startedAt: execution.startedAt,
          model: ctx.model, reasoningEffort: ctx.reasoningEffort });
        assert.match(notes[0], /native-.*思考档位：.*运行器报告.*codex_rollout.turn_context.*requested-model/);
        assert.match(notes[1], /上下文：未知/);
        assert.equal(stored.runtimeState.observedAt, result.runtimeState?.observedAt);
      }
    }
    console.log('Codex runtime: current-turn fixtures, filesystem isolation, execute/resume adapter, metadata and footnotes passed');
  } finally {
    [native.executeCodexTask, native.resumeCodexSession,
      prisma.taskRunParticipant.findUnique, prisma.taskRunParticipant.updateMany] = originals;
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
