import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { beginHarnessRuntimeExecution, persistSessionSize } from '../src/lib/harness-runtime-state';
import { readSessionSize } from '../src/lib/session-size';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

export async function verifySessionSizeRuntime() {
  const agent: { executeCodexTask: typeof import('../src/lib/real-agents/codex-agent').executeCodexTask;
    resumeCodexSession: typeof import('../src/lib/real-agents/codex-agent').resumeCodexSession } = require('../src/lib/real-agents/codex-agent');
  const originals = { findUnique: prisma.taskRunParticipant.findUnique, updateMany: prisma.taskRunParticipant.updateMany,
    execute: agent.executeCodexTask, resume: agent.resumeCodexSession };
  let metadata: Record<string, unknown> = { unrelated: 'retained' };
  let race = false;
  prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: JSON.stringify(metadata) })) as unknown as typeof originals.findUnique;
  prisma.taskRunParticipant.updateMany = (async ({ where, data }: { where: { controlMetadata: string }; data: { controlMetadata: string } }) => {
    if (race) { metadata.concurrent = 'preserved'; race = false; return { count: 0 }; }
    if (where.controlMetadata !== JSON.stringify(metadata)) return { count: 0 };
    metadata = JSON.parse(data.controlMetadata);
    return { count: 1 };
  }) as unknown as typeof originals.updateMany;
  const home = await mkdtemp(path.join(tmpdir(), 'ap-size-adapter-'));
  const id = '33333333-3333-3333-3333-333333333333';
  const file = path.join(home, 'sessions', `rollout-test-${id}.jsonl`);
  try {
    await mkdir(path.dirname(file));
    let execution = await beginHarnessRuntimeExecution('participant');
    const context: HarnessExecutionContext = { executionId: execution.id, workingDirectory: home,
      executionBackend: 'platform_local', timeout: 1000, codexHome: home,
      onSessionStarted: async session => { metadata.lastSessionId = session.sessionId; },
      onSessionSize: async sample => { await persistSessionSize(execution, sample); },
    };
    const read = () => readSessionSize(JSON.stringify(metadata), { participantId: 'participant', startedAt: execution.startedAt });
    agent.executeCodexTask = async (_task, options) => {
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
      await options!.onThreadStarted?.(id);
      await appendFile(file, 'fixture output\n');
      return { success: false, error: 'fixture failed', executionTime: 1, filesModified: [], output: '', threadId: id };
    };
    race = true;
    const result = await codexHarnessAdapter.execute({ task: { id: 'task', name: 'size fixture' }, context });
    assert.equal(result.success, false);
    const first = read();
    assert.ok(first && first.totalBytes > 0);
    assert.equal(first.deltaBytes, first.totalBytes);
    assert.equal(metadata.concurrent, 'preserved');
    assert.equal(metadata.unrelated, 'retained');
    assert.equal(await persistSessionSize(execution, { ...first, sessionId: 'other' }), false);
    const old = execution;
    execution = await beginHarnessRuntimeExecution('participant');
    context.executionId = execution.id;
    assert.equal(read(), null);
    assert.equal(await persistSessionSize(old, first), false, 'late writes from an earlier execution are discarded');
    agent.resumeCodexSession = async options => {
      await options.onThreadStarted?.(id);
      await appendFile(file, 'resumed output\n');
      throw new Error('fixture resume failed');
    };
    const resumed = await codexHarnessAdapter.resume!({ task: { id: 'task', name: 'fixture' }, context, sessionId: id, continuationMessage: 'continue' });
    assert.equal(resumed.success, false);
    assert.equal(read()?.deltaBytes, Buffer.byteLength('resumed output\n'));
    assert.equal(read()?.totalBytes, first.totalBytes + Buffer.byteLength('resumed output\n'));
    metadata.runtimeExecution = { ...execution, completedAt: Date.now() };
    assert.equal(await persistSessionSize(execution, { ...read()!, observedAt: Date.now() }), false, 'completed executions reject late samples');
    const previous = execution;
    execution = await beginHarnessRuntimeExecution('participant');
    const remote = { executionId: execution.id, sessionId: 'C:\\Users\\pi\\sessions\\member', totalBytes: 42, deltaBytes: 2, observedAt: Date.now() };
    assert.equal(await persistSessionSize(execution, remote, { sessionKind: 'pi_session_dir' }), true);
    assert.equal(read()?.totalBytes, 42);
    assert.equal(await persistSessionSize(previous, { ...remote, executionId: previous.id, sessionId: 'stale' }, { sessionKind: 'pi_session_dir' }), false);
    assert.equal(metadata.lastSessionId, remote.sessionId, 'late remote samples cannot overwrite native identity');
    console.log('Session size runtime: actual Codex adapter start/resume failure paths and metadata CAS/session/execution isolation passed');
  } finally {
    prisma.taskRunParticipant.findUnique = originals.findUnique;
    prisma.taskRunParticipant.updateMany = originals.updateMany;
    agent.executeCodexTask = originals.execute;
    agent.resumeCodexSession = originals.resume;
    await rm(home, { recursive: true, force: true });
  }
}
