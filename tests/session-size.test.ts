import assert from 'node:assert/strict';
import { verifySessionSizeRuntime } from './session-size-runtime-fixture';
import { mkdtemp, mkdir, writeFile, appendFile, stat, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCodexSessionFile, readCodexSessionBytes, withCodexSessionSize } from '../src/lib/real-agents/codex-session-size';
import { formatSessionSize, readSessionSize, sessionSizeThresholds, type SessionSizeSample } from '../src/lib/session-size';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import { buildLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import { turnReplyElements } from '../src/lib/agent-reply-card';

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'ap-session-size-'));
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const secondId = '22222222-2222-2222-2222-222222222222';
  const root = path.join(home, 'sessions');
  const file = path.join(root, `rollout-test-${sessionId}.jsonl`);
  const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n';
  const samples: SessionSizeSample[] = [];
  const scope = { executionId: 'execution', codexHome: home, onSample: (sample: SessionSizeSample) => { samples.push(sample); } };
  try {
    await mkdir(root);
    await withCodexSessionSize(scope, async bind => {
      await writeFile(file, header(sessionId));
      await bind(sessionId);
      await appendFile(file, '公开输出😀\n');
    });
    assert.equal(samples.at(-1)?.totalBytes, (await stat(file)).size);
    assert.equal(samples.at(-1)?.deltaBytes, samples.at(-1)?.totalBytes, 'fresh session includes the initial native record');
    const before = (await stat(file)).size;
    await withCodexSessionSize({ ...scope, sessionId }, async bind => {
      await bind(sessionId);
      await appendFile(file, JSON.stringify({ type: 'compacted', payload: 'short context' }) + '\n');
    });
    assert.equal(samples.at(-1)?.deltaBytes, (await stat(file)).size - before, 'compaction must not reset accumulated history');
    await assert.rejects(withCodexSessionSize({ ...scope, sessionId }, async bind => {
      await bind(sessionId);
      await appendFile(file, 'failed turn data\n');
      throw new Error('fixture failure');
    }), /fixture failure/);
    assert.equal(samples.at(-1)?.totalBytes, (await stat(file)).size, 'failed turns still measure their final bytes');
    await withCodexSessionSize({ ...scope, sessionId }, async bind => {
      await bind(sessionId);
      await writeFile(file, header(sessionId));
    });
    assert.equal(samples.at(-1)?.deltaBytes, undefined, 'shrinking/replaced history cannot produce a fabricated delta');
    const count = samples.length;
    await withCodexSessionSize({ ...scope, ephemeral: true }, async bind => { await bind(sessionId); });
    assert.equal(samples.length, count);
    await withCodexSessionSize({ ...scope, sessionId: secondId }, async bind => { await bind(secondId); });
    assert.equal(samples.length, count, 'missing file is not zero');
    const second = path.join(root, `rollout-test-${secondId}.jsonl`);
    await withCodexSessionSize(scope, async bind => {
      await writeFile(second, header(secondId));
      await bind(secondId);
    });
    assert.equal(samples.at(-1)?.sessionId, secondId);
    assert.equal(samples.at(-1)?.totalBytes, Buffer.byteLength(header(secondId)), 'new session starts its own measurement');
    await writeFile(second, header(sessionId));
    assert.equal(await readCodexSessionBytes({ root, file: second }, secondId), null, 'filename alone does not establish session identity');
    assert.equal(await findCodexSessionFile('../escape', home), null);
    const duplicate = path.join(root, `rollout-duplicate-${sessionId}.jsonl`);
    await writeFile(duplicate, header(sessionId));
    assert.equal(await findCodexSessionFile(sessionId, home), null, 'ambiguous histories are not guessed');
    await rm(duplicate);
    const outside = path.join(home, 'outside.jsonl');
    await writeFile(outside, header(sessionId));
    await rm(file);
    await symlink(outside, file);
    assert.equal(await findCodexSessionFile(sessionId, home), null, 'history must remain inside the configured home');
    await rm(file);
    await writeFile(file, header(sessionId));
    await truncate(file, 256 * 1024 ** 2);
    const measured = await readCodexSessionBytes({ root, file }, sessionId);
    assert.equal(measured?.bytes, 256 * 1024 ** 2, 'large history is measured without parsing the body');

    const now = Date.now();
    const sample: SessionSizeSample = { executionId: 'e', sessionId, totalBytes: 20 * 1024 ** 2, deltaBytes: 1024 ** 2, observedAt: now };
    const data = { lastSessionId: sessionId, runtimeExecution: { id: 'e', participantId: 'p', startedAt: now - 1 }, sessionSize: sample };
    const read = (metadata: unknown, participantId = 'p', startedAt = now - 1) => readSessionSize(JSON.stringify(metadata), { participantId, startedAt, now });
    assert.deepEqual(read(data), sample);
    assert.equal(read(data, 'other'), null);
    assert.equal(read(data, 'p', now), null);
    assert.equal(read({ ...data, lastSessionId: secondId }), null);
    assert.equal(read({ ...data, runtimeExecution: { ...data.runtimeExecution, id: 'new-execution' } }), null);
    assert.equal(read({ ...data, sessionSize: { ...sample, totalBytes: -1 } }), null);
    assert.equal(read({ ...data, sessionSize: { ...sample, deltaBytes: sample.totalBytes + 1 } }), null);
    assert.equal(read({ ...data, sessionSize: { ...sample, observedAt: now + 60_001 } }), null);
    assert.doesNotMatch(formatSessionSize({ ...sample, totalBytes: 10 * 1024 ** 2 - 1 }).join('\n'), /⚠️/);
    assert.match(formatSessionSize({ ...sample, totalBytes: 10 * 1024 ** 2 }).join('\n'), /⚠️.*建议/);
    assert.match(formatSessionSize(sample).join('\n'), /强提醒.*请先保存交接/);
    assert.deepEqual(sessionSizeThresholds({ AP_SESSION_SIZE_WARN_MIB: '5', AP_SESSION_SIZE_STRONG_MIB: '15' }), { warnMiB: 5, strongMiB: 15 });
    assert.deepEqual(sessionSizeThresholds({ AP_SESSION_SIZE_WARN_MIB: '30', AP_SESSION_SIZE_STRONG_MIB: '20' }), { warnMiB: 10, strongMiB: 20 });
    assert.match(formatSessionSize(null).join('\n'), /未采集/);
    const footnotes = buildLiveRoomFootnotes({ metadata: JSON.stringify(data), participantId: 'p', startedAt: now - 1, now });
    assert.match(footnotes.join('\n'), /20.00 MiB.*本轮新增：\+1.00 MiB/);
    for (const schema of [undefined, '2.0'] as const) {
      const elements = turnReplyElements({ active: false, latest: '', final: 'answer', process: '', tools: '', schema,
        footnotes: ['模型'.repeat(2000), ...formatSessionSize(sample)] });
      assert.match(JSON.stringify(elements.at(-1)), /强提醒/, 'size warning stays in the footer despite oversized model telemetry');
      assert.doesNotMatch(JSON.stringify(elements.slice(0, -1)), /强提醒/, 'reminders do not enter the body or process panels');
    }
    const cards: unknown[] = [];
    const tracker = new FeishuProgressTracker('fixture', undefined, 'Codex', async card => { cards.push(card); return 'original-card'; });
    await tracker.setSessionSize(sample);
    assert.match(JSON.stringify(cards.at(-1)), /强提醒/);
    tracker.setFootnotes(footnotes);
    await tracker.finalize('执行完成', true);
    assert.match(JSON.stringify(cards.at(-1)), /20.00 MiB/);
    assert.match(JSON.stringify(cards.at(-1)), /强提醒/);
    await verifySessionSizeRuntime();
    console.log('Session size: fresh/resume/failure/compaction/reset, identity and large files, thresholds and single-card rendering passed');
  } finally { await rm(home, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
