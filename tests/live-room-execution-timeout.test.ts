import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS,
  MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES,
  MIN_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES,
  parseLiveRoomExecutionTimeoutInput,
  liveRoomTimeoutMinutesToMs,
  liveRoomTimeoutMsToMinutes,
  resolveLiveRoomExecutionWatchdogConfig,
  resolveRemoteDeliveryStaleAfterMs,
  resolveRunningDeliveryStaleAfterMs,
  resolveLiveRoomExecutionTimeoutMs,
} from '../src/lib/live-room-execution-timeout';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import { piAgentHarnessAdapter } from '../src/lib/harness/adapters/pi-agent';
import { resolveHarnessTimeout } from '../src/lib/acpx/runner-harness';

const MINUTE = 60 * 1000;

// --- parseLiveRoomExecutionTimeoutInput -------------------------------------

assert.deepEqual(parseLiveRoomExecutionTimeoutInput(null), { kind: 'inherit' });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput(undefined), { kind: 'inherit' });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput(''), { kind: 'inherit' });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('   '), { kind: 'inherit' });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('inherit'), { kind: 'inherit' });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('INHERIT'), { kind: 'inherit' });

assert.deepEqual(parseLiveRoomExecutionTimeoutInput('1'), { kind: 'minutes', minutes: MIN_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('30'), { kind: 'minutes', minutes: 30 });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('60'), { kind: 'minutes', minutes: 60 });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput('1440'), { kind: 'minutes', minutes: MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput(' 45 '), { kind: 'minutes', minutes: 45 });
assert.deepEqual(parseLiveRoomExecutionTimeoutInput(90), { kind: 'minutes', minutes: 90 });

for (const invalid of ['0', '-3', '0.5', 'abc', 'NaN', '30m', '1e3', '1441', Number.NaN, Infinity]) {
  assert.deepEqual(
    parseLiveRoomExecutionTimeoutInput(invalid as string | number),
    { kind: 'invalid' },
    `expected ${String(invalid)} to be rejected`,
  );
}

assert.equal(liveRoomTimeoutMinutesToMs(30), 30 * MINUTE);
assert.equal(liveRoomTimeoutMsToMinutes(30 * MINUTE), 30);
assert.equal(resolveLiveRoomExecutionTimeoutMs(null), null);
assert.equal(resolveLiveRoomExecutionTimeoutMs(undefined), null);
assert.equal(resolveLiveRoomExecutionTimeoutMs(0), null);
assert.equal(resolveLiveRoomExecutionTimeoutMs(30 * MINUTE), 30 * MINUTE);

// --- watchdog config: null keeps defaults, explicit reaches every backend ---

// null: remote backends keep the runner-harness 10-minute default.
assert.equal(
  resolveLiveRoomExecutionWatchdogConfig({
    executionTimeoutMs: null,
    executionBackend: 'remote_ssh',
    harnessType: 'pi-agent',
  }),
  undefined,
);
assert.equal(
  resolveHarnessTimeout(
    resolveLiveRoomExecutionWatchdogConfig({
      executionTimeoutMs: null,
      executionBackend: 'remote_ssh',
      harnessType: 'pi-agent',
    })?.maxRuntimeMs,
    DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS,
  ),
  10 * MINUTE,
  'null room timeout must keep the 10-minute remote default',
);

// null: Platform Local codex/claude/kimi-code stay unlimited.
assert.deepEqual(
  resolveLiveRoomExecutionWatchdogConfig({
    executionTimeoutMs: null,
    executionBackend: 'platform_local',
    harnessType: 'codex',
  }),
  { maxRuntimeMs: null },
);
assert.deepEqual(
  resolveLiveRoomExecutionWatchdogConfig({
    executionTimeoutMs: null,
    executionBackend: 'platform_local',
    harnessType: 'kimi-code',
  }),
  { maxRuntimeMs: null },
);
// null: other local harnesses fall back to the 24h runner-harness default (undefined).
assert.equal(
  resolveLiveRoomExecutionWatchdogConfig({
    executionTimeoutMs: null,
    executionBackend: 'platform_local',
    harnessType: 'pi-agent',
  }),
  undefined,
);

// explicit value flows to remote ssh, remote runner and platform local alike.
for (const minutes of [30, 60, 90]) {
  const expectedMs = liveRoomTimeoutMinutesToMs(minutes);
  for (const backend of ['remote_ssh', 'platform_local']) {
    for (const harnessType of ['pi-agent', 'codex']) {
      const watchdogConfig = resolveLiveRoomExecutionWatchdogConfig({
        executionTimeoutMs: expectedMs,
        executionBackend: backend,
        harnessType,
      });
      assert.deepEqual(
        watchdogConfig,
        { maxRuntimeMs: expectedMs },
        `${minutes}min must reach ${backend}/${harnessType}`,
      );
      // Remote SSH and Remote Runner resolve through the same helper and must agree.
      assert.equal(
        resolveHarnessTimeout(watchdogConfig.maxRuntimeMs, DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS),
        expectedMs,
      );
    }
  }
}

// --- delivery reaper thresholds follow the room timeout + grace -------------

// Unset rooms keep exactly the previous 10m30s / 12m behavior.
assert.equal(resolveRemoteDeliveryStaleAfterMs(null), 10 * MINUTE + 30 * 1000);
assert.equal(resolveRemoteDeliveryStaleAfterMs(undefined), 10 * MINUTE + 30 * 1000);
assert.equal(resolveRunningDeliveryStaleAfterMs(null), 12 * MINUTE);

// A 30-minute room must not be reclaimed at the old 10m/12m marks…
assert.equal(resolveRemoteDeliveryStaleAfterMs(30 * MINUTE), 30 * MINUTE + 30 * 1000);
assert.equal(resolveRunningDeliveryStaleAfterMs(30 * MINUTE), 32 * MINUTE);
assert.ok(12 * MINUTE < resolveRunningDeliveryStaleAfterMs(30 * MINUTE));
assert.ok(12 * MINUTE < resolveRemoteDeliveryStaleAfterMs(30 * MINUTE));
// …and is only reclaimed past "configured value + grace".
assert.ok(30 * MINUTE + 31 * 1000 > resolveRemoteDeliveryStaleAfterMs(30 * MINUTE));
assert.ok(32 * MINUTE + 1000 > resolveRunningDeliveryStaleAfterMs(30 * MINUTE));

// --- wall-clock timeouts are not invalid continuations -----------------------

const WALL_CLOCK_TIMEOUT_MESSAGES = [
  'Codex execution timed out after 600000ms',
  'Remote SSH execution timed out after 600000ms',
  'Remote runner timed out after 600000ms',
  'Pi Agent execution timed out after 600000ms',
  'Claude execution timed out after 600000ms',
];
for (const message of WALL_CLOCK_TIMEOUT_MESSAGES) {
  assert.equal(
    codexHarnessAdapter.isInvalidContinuationError?.(message),
    false,
    `codex must not treat wall-clock timeout as invalid continuation: ${message}`,
  );
  assert.equal(
    piAgentHarnessAdapter.isInvalidContinuationError?.(message),
    false,
    `pi-agent must not treat wall-clock timeout as invalid continuation: ${message}`,
  );
}

// Explicit session/thread invalid signals still invalidate continuations.
assert.equal(codexHarnessAdapter.isInvalidContinuationError?.('session abc not found'), true);
assert.equal(codexHarnessAdapter.isInvalidContinuationError?.('thread resume failed'), true);
assert.equal(piAgentHarnessAdapter.isInvalidContinuationError?.('No session found'), true);
assert.equal(piAgentHarnessAdapter.isInvalidContinuationError?.('Stored session working directory does not exist'), true);

// --- the live-room execution chain wires these pieces together ---------------

const execution = readFileSync('src/lib/live-room-delivery-execution.ts', 'utf8');
const processing = readFileSync('src/lib/live-room-delivery-processing.ts', 'utf8');
const cleanup = readFileSync('src/lib/feishu-runtime-cleanup.ts', 'utf8');

assert.match(
  execution,
  /resolveLiveRoomExecutionWatchdogConfig\(\{\s*executionTimeoutMs: room\.executionTimeoutMs/,
  'runLiveRoomAcpxAttempt must resolve the watchdog from the room timeout',
);
assert.match(
  execution,
  /续聊会话失效，自动开启新会话重试/,
  'the fresh-session fallback message must remain for real session-invalid errors',
);
assert.ok(
  !/timed out after \\d\+ms/i.test(execution),
  'live-room execution must not retry on generic wall-clock timeouts',
);
assert.match(
  processing,
  /failStaleRemoteDeliveries\(targetMember\.id, room\.executionTimeoutMs\)/,
  'remote delivery reaping must use the room execution timeout',
);
assert.match(
  processing,
  /本次回复执行超时/,
  'wall-clock timeout failures must be reported as 执行超时, never as 续聊会话失效',
);
assert.ok(
  !/续聊会话失效[\s\S]*timed out/.test(processing),
  'timeout handling must not be coupled to continuation invalidation',
);
assert.match(
  cleanup,
  /resolveRunningDeliveryStaleAfterMs\(delivery\.roomMessage\?\.room\?\.executionTimeoutMs\)/,
  'the running-delivery watchdog must use the owning room timeout',
);

console.log('Live room execution timeout tests passed');
