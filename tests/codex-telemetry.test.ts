import assert from 'node:assert/strict';
import {
  clearCodexQuotaCacheForTests,
  getCodexProviderContextUsage,
  parseCodexTokenUsage,
  readCodexQuotaCache,
  shouldReplaceCodexTokenUsage,
  updateCodexQuotaCache,
} from '../src/lib/codex-telemetry';
import { serializeLiveRoomMember } from '../src/lib/live-room-members';

const payload = (threadId = 'thread-1', totalTokens = 52_500) => ({
  threadId,
  turnId: 'turn-1',
  tokenUsage: {
    last: {
      inputTokens: 50_000,
      cachedInputTokens: 1_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      totalTokens: 52_500,
    },
    total: {
      inputTokens: 50_000,
      cachedInputTokens: 1_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      totalTokens,
    },
    modelContextWindow: 100_000,
  },
});

const collectedAt = new Date('2026-07-29T05:00:00.000Z');
const usage = parseCodexTokenUsage(payload(), collectedAt);
assert.ok(usage);
assert.equal(usage.source, 'codex_app_server');
assert.doesNotMatch(JSON.stringify(usage), /quota|account|credential|auth/i);
assert.equal(parseCodexTokenUsage({ threadId: 'missing' }), null);
assert.equal(getCodexProviderContextUsage(
  JSON.stringify({ codexThreadId: 'thread-1', codexTokenUsage: usage }),
  new Date('2026-07-29T05:05:00.000Z'),
)?.usagePercentage, 50);
assert.equal(getCodexProviderContextUsage(
  JSON.stringify({ codexThreadId: 'thread-1', codexTokenUsage: usage }),
  new Date('2026-07-29T05:16:00.000Z'),
), null);
assert.equal(getCodexProviderContextUsage(
  JSON.stringify({ codexThreadId: 'thread-2', codexTokenUsage: usage }),
  new Date('2026-07-29T05:05:00.000Z'),
), null);

const older = parseCodexTokenUsage(payload('thread-1', 40_000), new Date('2026-07-29T04:59:00.000Z'))!;
const regressed = parseCodexTokenUsage(payload('thread-1', 40_000), new Date('2026-07-29T05:01:00.000Z'))!;
const newThread = parseCodexTokenUsage(payload('thread-2', 1_000), new Date('2026-07-29T05:01:00.000Z'))!;
assert.equal(shouldReplaceCodexTokenUsage(usage, older), false);
assert.equal(shouldReplaceCodexTokenUsage(usage, regressed), false);
assert.equal(shouldReplaceCodexTokenUsage(usage, newThread), true);

clearCodexQuotaCacheForTests();
updateCodexQuotaCache({
  codexHome: '/tmp/account-a',
  snapshot: true,
  collectedAt,
  rateLimits: {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_893_456_000 },
    secondary: null,
    planType: 'secret-not-retained',
  },
});
updateCodexQuotaCache({
  codexHome: '/tmp/account-a',
  collectedAt: new Date('2026-07-29T05:01:00.000Z'),
  rateLimits: {
    secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_894_060_800 },
  },
});
updateCodexQuotaCache({
  codexHome: '/tmp/account-a',
  collectedAt: new Date('2026-07-29T04:59:00.000Z'),
  rateLimits: {
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_893_456_000 },
  },
});
const quota = readCodexQuotaCache('/tmp/account-a', new Date('2026-07-29T05:02:00.000Z'));
assert.equal(quota?.primary?.usedPercent, 25);
assert.equal(quota?.secondary?.usedPercent, 10);
assert.equal('planType' in (quota || {}), false);
assert.equal(readCodexQuotaCache('/tmp/account-b', new Date('2026-07-29T05:02:00.000Z')), null);
assert.equal(readCodexQuotaCache('/tmp/account-a', new Date('2026-07-29T05:07:00.001Z')), null);

const ordinaryPayload = serializeLiveRoomMember({
  id: 'member',
  roomId: 'room',
  memberType: 'local_agent',
  displayName: 'Codex',
  agentNameSnapshot: 'Codex',
  harnessType: 'codex',
  backend: 'platform_local',
  runtimeAgentId: null,
  roleLabel: null,
  role: 'custom',
  joinStatus: 'joined',
  presenceStatus: 'online',
  canReply: true,
  sortOrder: 1,
  gatewayId: null,
  agentRecordId: null,
});
assert.doesNotMatch(JSON.stringify(ordinaryPayload), /quota|account|credential|auth/i);

console.log('codex telemetry checks passed');
