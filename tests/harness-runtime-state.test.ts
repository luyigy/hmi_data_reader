import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { collectLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import { getLiveRoomMemberContextWatermark } from '../src/lib/live-room-members';
import { beginHarnessRuntimeExecution, persistHarnessRuntimeState, readHarnessRuntimeState } from '../src/lib/harness-runtime-state';
import type { HarnessExecuteArgs, HarnessExecuteResult, HarnessRuntimeState } from '../src/lib/harness/types';
import type { AcpxParticipantRequest, AcpxRunRequest } from '../src/lib/acpx/types';

async function main() {
  const harness = require('../src/lib/harness/registry');
  const taskRoom = require('../src/lib/task-room');
  const originals = [harness.getHarnessAdapter, taskRoom.ensureTaskChatRoom,
    prisma.taskRunParticipant.findUnique, prisma.taskRunParticipant.findFirst,
    prisma.taskRunParticipant.update, prisma.taskRunParticipant.updateMany,
    prisma.taskRun.findUnique, prisma.taskRun.update, prisma.message.findMany, prisma.taskRunEvent.count, Date.now];
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let stored: Record<string, any> = { continuationKey: 'member', unrelated: { retained: true } };
  let run: Record<string, unknown> = {};
  let race = false;
  let unavailable = false;
  const row = () => ({ id: 'participant', controlMetadata: JSON.stringify(stored) });
  prisma.taskRunParticipant.findUnique = (async () => row()) as any;
  prisma.taskRunParticipant.findFirst = (async () => row()) as any;
  prisma.taskRunParticipant.update = (async ({ data }: any) => { stored = JSON.parse(data.controlMetadata); return row(); }) as any;
  prisma.taskRunParticipant.updateMany = (async ({ where, data }: any) => {
    if (unavailable) throw new Error('storage unavailable');
    if (race) { stored.concurrentField = 'preserved'; race = false; return { count: 0 }; }
    if (where.controlMetadata !== JSON.stringify(stored)) return { count: 0 };
    stored = JSON.parse(data.controlMetadata);
    return { count: 1 };
  }) as any;
  prisma.taskRun.findUnique = (async () => ({ controlMetadata: JSON.stringify(run) })) as any;
  prisma.taskRun.update = (async ({ data }: any) => { run = JSON.parse(data.controlMetadata); }) as any;
  prisma.message.findMany = (async () => []) as any;
  prisma.taskRunEvent.count = (async () => 0) as any;
  taskRoom.ensureTaskChatRoom = async () => ({ id: 'room' });

  let native: (args: HarnessExecuteArgs) => Promise<HarnessExecuteResult>;
  harness.getHarnessAdapter = () => ({ displayName: 'test', execute: (args: HarnessExecuteArgs) => native(args), resume: (args: HarnessExecuteArgs) => native(args) });
  const participant: AcpxParticipantRequest = { gatewayId: 'platform-local', executionBackend: 'platform_local',
    harnessType: 'pi-agent', role: 'custom', model: 'requested-model', reasoningEffort: 'requested-effort' };
  const request: AcpxRunRequest = { taskId: 'task', taskName: 'test', orchestrationMode: 'single', participants: [participant] };
  const execute = (resume = false) => executeViaLocalHarness(request, 'run', 'participant',
    { ...participant, ...(resume ? { resumeSessionId: 'session', continuationMessage: 'continue' } : {}) },
    {}, [], { transcript: '', latestUserMessage: null });
  const state = (args: HarnessExecuteArgs, patch: Partial<HarnessRuntimeState> = {}): HarnessRuntimeState => ({
    executionId: args.context.executionId!, sessionId: 'session', model: 'actual-model', modelKind: 'model_id',
    provider: 'native-provider', reasoning: { kind: 'level', value: 'native-high' },
    evidence: 'runner', source: 'native-test-receipt', observedAt: now, ...patch,
  });
  const success = (runtimeState?: HarnessRuntimeState): HarnessExecuteResult => ({ success: true,
    output: 'answer', executionTime: 1, sessionId: 'session', sessionKind: 'test_session', runtimeState });
  const read = (options: { startedAt?: number; now?: number; participantId?: string } = {}) =>
    readHarnessRuntimeState(JSON.stringify(stored), { participantId: 'participant', ...options });
  const footnotes = (startedAt: number) => collectLiveRoomFootnotes({ participantId: 'participant', startedAt, now,
    model: participant.model, reasoningEffort: participant.reasoningEffort });
  const panel = () => getLiveRoomMemberContextWatermark({
    member: { id: 'member', displayName: 'test', backend: 'platform_local', harnessType: participant.harnessType,
      gatewayId: null, runtimeAgentId: null, role: 'custom', roleLabel: null },
    sourceTask: { id: 'task', name: 'test' },
  });
  try {
    // Real runner -> session metadata -> independent state -> both public consumers.
    for (const type of ['codex', 'pi-agent', 'antigravity', 'kimi-code']) {
      participant.harnessType = type;
      for (const resume of [false, true]) {
        const startedAt = ++now;
        native = async args => success(state(args));
        race = true;
        await execute(resume);
        assert.equal(read()?.model, 'actual-model');
        assert.equal(stored.concurrentField, 'preserved');
        assert.deepEqual(stored.unrelated, { retained: true });
        assert.equal(stored.contextUsage, undefined, 'no invented zero tokens/window');
        const notes = await footnotes(startedAt);
        assert.match(notes[0], /actual-model.*native-high.*运行器报告.*native-test-receipt.*requested-model/);
        assert.match(notes[1], /上下文：未知/);
        assert.match((await panel())!.modelLabel!, /actual-model.*native-high.*最近观测/);
      }
    }
    const saved = await footnotes(now);
    const savedJson = JSON.stringify(saved);
    for (const [reasoning, expected] of [
      [{ kind: 'toggle', enabled: false }, /思考开关：关闭/],
      [{ kind: 'toggle', enabled: true }, /思考开关：开启/],
      [{ kind: 'not_applicable' }, /不适用/], [{ kind: 'unknown' }, /思考状态：实际值未确认/],
    ] as const) {
      ++now;
      native = async args => success(state(args, { reasoning, modelKind: 'alias' }));
      await execute();
      assert.match((await footnotes(now))[0], expected);
      assert.match((await panel())!.modelLabel!, /actual-model（别名）/);
    }
    assert.equal(JSON.stringify(saved), savedJson, 'historical strings remain snapshots');

    // Long execution: observation time is retained, not refreshed to completion/read time.
    const startedAt = ++now;
    native = async args => {
      const evidence = state(args);
      now += 2 * 60 * 60 * 1000;
      return success(evidence);
    };
    await execute();
    assert.equal(read()?.observedAt, startedAt);
    assert.match((await footnotes(startedAt))[0], /actual-model/);
    assert.match((await panel())!.modelLabel!, /actual-model/);
    assert.equal(read({ now: now + 900_001 }), null, 'expired member panel');
    assert.equal(read({ startedAt: now + 1 }), null, 'previous execution rejected for new reply');
    assert.equal(read({ participantId: 'other-member' }), null);
    const validMetadata = JSON.parse(JSON.stringify(stored));
    stored.lastSessionId = 'reset-session';
    assert.equal(read(), null);
    stored = validMetadata;

    // The final result cannot refresh or overwrite a previously saved execution.
    const execution = stored.runtimeExecution;
    const evidence = stored.runtimeState;
    await persistHarnessRuntimeState(execution, { ...evidence, model: 'late-old-result' });
    assert.equal(read()?.model, 'actual-model');
    const nextExecution = await beginHarnessRuntimeExecution('participant');
    await persistHarnessRuntimeState(execution, evidence);
    assert.equal(read(), null);
    assert.equal(stored.runtimeExecution.id, nextExecution.id);

    // Invalid/native missing fields and old events fail closed, independent of requested settings.
    for (const patch of [
      { model: 3 }, { modelKind: 'requested' }, { reasoning: { kind: 'level', value: 4 } },
      { reasoning: { kind: 'toggle', enabled: 'false' } }, { reasoning: { kind: 'off' } },
      { reasoning: null }, { source: '' }, { evidence: 'request' }, { observedAt: now - 1 },
      { observedAt: now + 1 }, { executionId: 'previous-execution' }, { sessionId: 'other' },
    ]) {
      ++now;
      native = async args => success(state(args, patch as any));
      await execute();
      assert.equal(read(), null, JSON.stringify(patch));
      assert.match((await panel())!.modelLabel!, /模型：实际值未确认/);
    }
    ++now;
    native = async args => success({ ...state(args), rawLog: 'must not persist' } as HarnessRuntimeState);
    await execute();
    assert.equal(stored.runtimeState.rawLog, undefined);
    ++now;
    native = async args => success(state(args, { model: undefined, modelKind: undefined }));
    await execute();
    assert.match((await footnotes(now))[0], /模型：实际值未确认.*native-high/);

    // No result evidence, failure, timeout or unbound session cannot reuse prior success.
    for (const mode of ['missing', 'failed', 'timeout', 'unbound']) {
      ++now;
      native = async args => {
        assert.equal(read(), null, 'begin invalidates prior execution before native work');
        if (mode === 'timeout') throw new Error('timeout');
        return mode === 'missing' ? success() : { ...success(state(args)),
          ...(mode === 'failed' ? { success: false, error: 'failed' } : { sessionId: undefined, sessionKind: undefined }) };
      };
      if (mode === 'failed' || mode === 'timeout') await assert.rejects(execute(), new RegExp(mode));
      else await execute();
      assert.equal(read(), null);
    }
    // Callbacks need not be awaited by a producer: runner drains session/token writes first.
    ++now;
    native = async args => {
      void args.context.onSessionStarted!({ sessionId: 'session', sessionKind: 'test_session' });
      void args.context.onContextUsage!({ sessionId: 'session', usedTokens: 5, metricKind: 'turn_input',
        confidence: 'measured_exact', collectedAt: now });
      return success(state(args));
    };
    await execute();
    assert.equal(stored.contextUsage.usedTokens, 5);
    assert.equal(read()?.model, 'actual-model');
    // Legacy token model alone is not execution-bound runtime evidence.
    ++now;
    native = async () => success();
    await execute();
    stored.contextUsage.model = 'old-token-model';
    assert.match((await footnotes(now))[0], /模型：实际值未确认/);
    for (const metadata of ['{invalid', 'null', '[]', JSON.stringify({ runtimeState: 3 })]) {
      assert.equal(readHarnessRuntimeState(metadata, { participantId: 'participant' }), null);
    }
    // Telemetry-only storage failure is diagnostic, not a failed task.
    native = async args => { unavailable = true; return success(state(args)); };
    await execute();
    assert.equal(read(), null);
    await execute();
    unavailable = false;
    prisma.taskRunParticipant.update = (async () => { throw new Error('session write unavailable'); }) as any;
    native = async args => success(state(args));
    await execute();
    assert.equal(read(), null, 'session storage failure cannot accept runtime evidence or fail the task');
    console.log('runtime state tests passed: four harness contracts, persistence, footnotes, panels, isolation and failures');
  } finally {
    [harness.getHarnessAdapter, taskRoom.ensureTaskChatRoom,
      prisma.taskRunParticipant.findUnique, prisma.taskRunParticipant.findFirst,
      prisma.taskRunParticipant.update, prisma.taskRunParticipant.updateMany,
      prisma.taskRun.findUnique, prisma.taskRun.update, prisma.message.findMany, prisma.taskRunEvent.count, Date.now] = originals as any;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
