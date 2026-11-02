import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { collectLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import { buildAssistantRelayCard } from '../src/lib/feishu-live-room-relay';
import type { LiveRoomMessagePayload } from '../src/lib/live-room-types';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-display-'));
  const binary = path.join(dir, 'kimi');
  const originalBinary = process.env.KIMI_CODE_CLI_PATH;
  const originalFind = prisma.taskRunParticipant.findUnique;
  const now = Date.now();
  const state = { executionId: 'execution', sessionId: 'session', model: 'kimi-for-coding', modelKind: 'model_id',
    reasoning: { kind: 'level', value: 'max' }, source: 'kimi_wire.llm.request', evidence: 'runner', observedAt: now };
  const metadata = { lastSessionId: 'session',
    runtimeExecution: { id: 'execution', participantId: 'participant', startedAt: now - 1000, completedAt: now }, runtimeState: state };
  prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: JSON.stringify(metadata) })) as unknown as typeof originalFind;
  process.env.KIMI_CODE_CLI_PATH = binary;
  const setCatalog = async (models: object) => {
    const catalog = JSON.stringify({ models });
    await writeFile(binary, `#!/bin/sh\ncat <<'CATALOG'\n${catalog}\nCATALOG\n`, { mode: 0o755 });
  };
  const notes = () => collectLiveRoomFootnotes({ participantId: 'participant', startedAt: now - 1000, now,
    model: 'kimi-code/kimi-for-coding' });
  try {
    await setCatalog({
      'kimi-code/kimi-for-coding': { model: 'kimi-for-coding', displayName: 'K2.8 Preview' },
      'kimi-code/k3.1-pro': { model: 'k3.1-pro', displayName: 'K3.1 Pro' },
    });
    const footnotes = await notes();
    assert.match(footnotes[0], /模型：K2\.8 Preview（kimi-for-coding）.*思考档位：max/);
    const card = buildAssistantRelayCard({ content: 'answer', senderName: 'kimi-code', metadata: { footnotes } } as unknown as LiveRoomMessagePayload);
    assert.match(JSON.stringify(card), /K2\.8 Preview（kimi-for-coding）/);
    state.model = 'k3.1-pro';
    assert.match((await notes())[0], /模型：K3\.1 Pro（k3\.1-pro）/);
    assert.doesNotMatch((await notes())[0], /K2\.8 Preview/, 'requested model must not relabel the actual model');
    state.model = 'kimi-code/kimi-for-coding';
    state.modelKind = 'alias';
    assert.match((await notes())[0], /K2\.8 Preview（kimi-code\/kimi-for-coding）/);
    state.model = 'unknown';
    assert.match((await notes())[0], /模型：unknown（别名）/);
    state.model = 'kimi-for-coding';
    state.modelKind = 'model_id';
    state.source = 'another-runner';
    assert.match((await notes())[0], /模型：kimi-for-coding ·/);
    state.source = 'kimi_wire.llm.request';
    metadata.lastSessionId = 'other-session';
    assert.match((await notes())[0], /模型：实际值未确认/);
    metadata.lastSessionId = 'session';
    for (const models of [
      { alias: { model: 'kimi-for-coding' } },
      { a: { model: 'kimi-for-coding', displayName: 'A' }, b: { model: 'kimi-for-coding', displayName: 'B' } },
      { alias: { model: 'kimi-for-coding', displayName: 'bad\nname' } },
    ]) {
      await setCatalog(models);
      assert.match((await notes())[0], /模型：kimi-for-coding ·/);
    }
    await writeFile(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.match((await notes())[0], /模型：kimi-for-coding ·/);
    console.log('Kimi display: catalog names reach reply cards; raw IDs survive missing/ambiguous names and CLI failure');
  } finally {
    prisma.taskRunParticipant.findUnique = originalFind;
    if (originalBinary === undefined) delete process.env.KIMI_CODE_CLI_PATH; else process.env.KIMI_CODE_CLI_PATH = originalBinary;
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
