import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { executeRemoteSshTask } from '../src/lib/remote-harness/ssh-executor';
import { getRemoteHarnessHostById } from '../src/lib/remote-harness/hosts';
import { buildLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import { prisma } from '../src/lib/prisma';

async function main() {
  const hostId = process.env.AP_PI_TELEMETRY_TEST_HOST_ID;
  if (!hostId) { console.log('Skip native SSH Pi: set AP_PI_TELEMETRY_TEST_HOST_ID'); return; }
  loadEnvConfig(process.env.AP_ROOT || process.cwd());
  const host = await getRemoteHarnessHostById(hostId);
  assert.ok(host);
  const task = { id: `telemetry-smoke-${randomUUID()}`, name: 'Telemetry smoke test',
    description: 'Reply exactly AP_TELEMETRY_OK. Do not use tools, inspect or modify files, change settings, or contact anyone.' };
  let sessionId: string | undefined;
  let previousSize = 0;
  let previousTurn: string | undefined;
  for (let turn = 1; turn <= 2; turn++) {
    const executionId = randomUUID(), startedAt = Date.now();
    let size: { totalBytes: number; deltaBytes?: number } | undefined;
    const result = await executeRemoteSshTask(task, {
      host: { ...host, workingDirectory: '/tmp' }, harnessType: 'pi-agent', timeout: 120_000, executionId,
      resumeSessionId: sessionId, continuationMessage: 'Reply exactly AP_TELEMETRY_OK again. Do not use tools or change any files.',
      onSessionSize: (_session, value) => { size = value; },
    });
    const completedAt = Date.now();
    assert.match(result.output, /AP_TELEMETRY_OK/);
    assert.ok(result.sessionId);
    assert.ok(result.runtimeState?.model);
    assert.ok(result.contextUsage && result.contextUsage.usedTokens > 0);
    assert.ok(size && size.totalBytes > previousSize);
    assert.equal(result.runtimeState.executionId, executionId);
    assert.notEqual(result.runtimeState.turnId, previousTurn);
    if (sessionId) {
      assert.equal(result.sessionId, sessionId);
      assert.equal(size.deltaBytes, size.totalBytes - previousSize);
    }
    sessionId = result.sessionId; previousSize = size.totalBytes; previousTurn = result.runtimeState.turnId;
    const notes = buildLiveRoomFootnotes({ participantId: 'smoke', startedAt,
      metadata: JSON.stringify({ lastSessionId: sessionId, runtimeExecution: { id: executionId, participantId: 'smoke', startedAt, completedAt },
        runtimeState: result.runtimeState, contextUsage: result.contextUsage,
        sessionSize: { ...size, sessionId, executionId, observedAt: completedAt } }),
    });
    assert.doesNotMatch(notes.join('\n'), /未采集|实际值未确认|遥测缺失/);
    console.log(JSON.stringify({ turn, sessionId, size, runtimeState: result.runtimeState, contextUsage: result.contextUsage, footnotes: notes }));
  }
  console.log('Native SSH Pi two-turn telemetry passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
