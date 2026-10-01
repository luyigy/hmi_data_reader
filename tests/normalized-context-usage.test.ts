import assert from 'node:assert/strict';
import { readContextUsage, contextUsagePercentage, persistContextUsage } from '../src/lib/context-usage';
import { parseAntigravityUsageFromText } from '../src/lib/real-agents/antigravity-context';
import { prisma } from '../src/lib/prisma';
import type { NormalizedContextUsage } from '../src/lib/harness/types';

const now = Date.now();
const usage: NormalizedContextUsage = {
  usedTokens: 85, contextWindow: 100, metricKind: 'session_context',
  confidence: 'measured_exact', sessionId: 'session', collectedAt: now,
};
const metadata = (contextUsage: unknown) => JSON.stringify({ lastSessionId: 'session', contextUsage });
assert.equal(contextUsagePercentage(readContextUsage(metadata(usage), now)), 85);
for (const patch of [
  { usedTokens: -1 }, { usedTokens: '85' }, { sessionId: 'other' },
  { sessionId: undefined }, { collectedAt: now - 900_001 },
  { collectedAt: now + 60_001 }, { contextWindow: 0 },
  { confidence: 'guess' }, { metricKind: 'quota' }, { usagePercentage: -1 },
]) assert.equal(readContextUsage(metadata({ ...usage, ...patch }), now), null);
for (const patch of [
  { metricKind: 'cumulative' }, { confidence: 'inferred_text' },
  { confidence: 'assumed_window' }, { contextWindow: undefined },
]) assert.equal(contextUsagePercentage(readContextUsage(metadata({ ...usage, ...patch }), now)), null);
assert.equal(readContextUsage('{invalid'), null);
assert.equal(readContextUsage('null'), null);
assert.equal(contextUsagePercentage(readContextUsage(metadata({ ...usage, usedTokens: 12 }), now)), 12,
  'compaction may reduce the watermark');
const breakdown = { inputTokens: 85, totalTokens: 2000 };
const old = {
  codexThreadId: 'session',
  codexTokenUsage: {
    source: 'codex_app_server', threadId: 'session', turnId: 'turn',
    last: breakdown, total: breakdown, modelContextWindow: 100,
    collectedAt: new Date(now).toISOString(),
  },
};
assert.equal(contextUsagePercentage(readContextUsage(JSON.stringify(old), now)), 85);
assert.equal(readContextUsage(JSON.stringify({ ...old, contextUsage: null }), now), null);
assert.equal(readContextUsage(JSON.stringify({ ...old, lastSessionId: 'new' }), now), null);
assert.equal(contextUsagePercentage(readContextUsage(JSON.stringify({
  lastSessionId: 'session', lastSessionKind: 'kimi_session',
  kimiCodeContextUsage: {
    source: 'kimi_wire', sessionId: 'session', usedTokens: 85, contextWindow: 100,
    modelAlias: 'model', protocolVersion: '1', collectedAt: new Date(now).toISOString(),
  },
}), now)), 85);
assert.equal(parseAntigravityUsageFromText('{"usage":{"input_tokens":85,"context_window":100}}')?.confidence, 'measured_exact');
assert.equal(parseAntigravityUsageFromText('{"usage":{"input_tokens":85}}')?.confidence, 'assumed_window');
assert.equal(parseAntigravityUsageFromText('input_tokens: 85')?.confidence, 'inferred_text');
assert.equal(parseAntigravityUsageFromText('tokens: 1\n{"usage":{"input_tokens":85}}')?.lastRunInputTokens, 85);

async function main() {
  const find = prisma.taskRunParticipant.findUnique;
  const update = prisma.taskRunParticipant.update;
  let stored = { lastSessionId: 'session', continuationKey: 'member', contextUsage: usage };
  let writes = 0;
  prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: JSON.stringify(stored) })) as unknown as typeof find;
  prisma.taskRunParticipant.update = (async (args: { data: { controlMetadata: string } }) => {
    stored = JSON.parse(args.data.controlMetadata); writes++;
  }) as unknown as typeof update;
  try {
    await persistContextUsage('participant', { ...usage, collectedAt: now - 1 });
    await persistContextUsage('participant', { ...usage, sessionId: 'other' });
    assert.equal(writes, 0);
    await persistContextUsage('participant', { ...usage, usedTokens: 12, collectedAt: now + 1 });
    assert.equal(writes, 1);
    assert.equal(stored.contextUsage.usedTokens, 12);
    assert.equal(stored.continuationKey, 'member');
  } finally {
    prisma.taskRunParticipant.findUnique = find;
    prisma.taskRunParticipant.update = update;
  }
  console.log('normalized context usage tests passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
