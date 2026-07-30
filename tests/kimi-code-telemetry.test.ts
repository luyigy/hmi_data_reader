import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import {
  collectKimiCodeProviderContextUsage,
  getKimiCodeProviderContextUsage,
  parseKimiCodeModelContextWindow,
  persistKimiCodeContextUsageMetadata,
  readKimiCodeContextUsageMetadata,
  shouldReplaceKimiCodeContextUsage,
  type KimiCodeProviderContextUsage,
} from '../src/lib/real-agents/kimi-code-telemetry';

const now = new Date('2026-07-30T08:00:00.000Z');
const usage: KimiCodeProviderContextUsage = {
  source: 'kimi_wire',
  collectedAt: now.toISOString(),
  sessionId: 'session-1',
  modelAlias: 'kimi-code/k3',
  usedTokens: 30,
  contextWindow: 1_000,
  protocolVersion: '1.4',
};

assert.equal(parseKimiCodeModelContextWindow(`
[models."kimi-code/k3"]
max_context_size = 1_048_576
`, 'kimi-code/k3'), 1_048_576);
assert.equal(parseKimiCodeModelContextWindow(`
[models.other]
max_context_size = 100
`, 'kimi-code/k3'), null);
assert.equal(parseKimiCodeModelContextWindow(`
[models."kimi-code/k3"]
max_context_size = 0
`, 'kimi-code/k3'), null);

assert.deepEqual(readKimiCodeContextUsageMetadata({
  lastSessionId: 'session-1',
  lastSessionKind: 'kimi_session',
  kimiCodeContextUsage: usage,
}, now), usage);
assert.equal(readKimiCodeContextUsageMetadata({
  lastSessionId: 'session-2',
  lastSessionKind: 'kimi_session',
  kimiCodeContextUsage: usage,
}, now), null);
assert.equal(readKimiCodeContextUsageMetadata({
  lastSessionId: 'session-1',
  lastSessionKind: 'claude_session',
  kimiCodeContextUsage: usage,
}, now), null);
assert.equal(readKimiCodeContextUsageMetadata({
  lastSessionId: 'session-1',
  lastSessionKind: 'kimi_session',
  kimiCodeContextUsage: usage,
}, new Date(now.getTime() + 15 * 60 * 1000 + 1)), null);
assert.deepEqual(getKimiCodeProviderContextUsage(JSON.stringify({
  lastSessionId: 'session-1',
  lastSessionKind: 'kimi_session',
  kimiCodeContextUsage: usage,
}), now), {
  usagePercentage: 3,
  usedTokens: 30,
  contextWindow: 1_000,
});
assert.equal(getKimiCodeProviderContextUsage('{', now), null);

assert.equal(shouldReplaceKimiCodeContextUsage(usage, {
  ...usage,
  collectedAt: new Date(now.getTime() - 1).toISOString(),
  usedTokens: 40,
}), false);
assert.equal(shouldReplaceKimiCodeContextUsage(usage, {
  ...usage,
  collectedAt: new Date(now.getTime() + 1).toISOString(),
  usedTokens: 10,
}), true);

const main = async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-telemetry-'));
  try {
  const wireDirectory = path.join(
    home,
    'sessions',
    'workspace',
    'session_session-1',
    'agents',
    'main'
  );
  await mkdir(wireDirectory, { recursive: true });
  await writeFile(path.join(home, 'config.toml'), `
[models."kimi-code/k3"]
max_context_size = 1_000
`);
  await writeFile(path.join(wireDirectory, 'wire.jsonl'), [
    '{"type":"metadata","protocol_version":"1.4"}',
    '{"type":"config.update","modelAlias":"kimi-code/k3"}',
    '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputCacheRead":20,"inputCacheCreation":0,"inputOther":8,"output":2}}}',
  ].join('\n'));

    assert.deepEqual(await collectKimiCodeProviderContextUsage({
      sessionId: 'session-1',
      home,
      collectedAt: now,
    }), usage);
    assert.equal(await collectKimiCodeProviderContextUsage({
      sessionId: '../escape',
      home,
      collectedAt: now,
    }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const originalFindUnique = prisma.taskRunParticipant.findUnique;
  const originalUpdate = prisma.taskRunParticipant.update;
  let metadata = JSON.stringify({
    continuationKey: 'live-room-member:kimi',
    lastSessionId: 'session-1',
    lastSessionKind: 'kimi_session',
    kimiCodeContextUsage: usage,
  });
  prisma.taskRunParticipant.findUnique = (async () => ({
    controlMetadata: metadata,
  })) as unknown as typeof prisma.taskRunParticipant.findUnique;
  prisma.taskRunParticipant.update = (async (args: { data: { controlMetadata: string } }) => {
    metadata = args.data.controlMetadata;
    return {};
  }) as unknown as typeof prisma.taskRunParticipant.update;
  try {
    await persistKimiCodeContextUsageMetadata('participant-1', {
      ...usage,
      collectedAt: new Date(now.getTime() + 1).toISOString(),
      usedTokens: 10,
    });
    assert.equal(
      (JSON.parse(metadata).kimiCodeContextUsage as KimiCodeProviderContextUsage).usedTokens,
      10
    );
    assert.equal(JSON.parse(metadata).continuationKey, 'live-room-member:kimi');
    await persistKimiCodeContextUsageMetadata('participant-1', {
      ...usage,
      collectedAt: new Date(now.getTime() - 1).toISOString(),
      usedTokens: 40,
    });
    assert.equal(
      (JSON.parse(metadata).kimiCodeContextUsage as KimiCodeProviderContextUsage).usedTokens,
      10
    );
  } finally {
    prisma.taskRunParticipant.findUnique = originalFindUnique;
    prisma.taskRunParticipant.update = originalUpdate;
  }

  console.log('kimi code telemetry tests passed');
};

void main();
