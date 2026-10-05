import { parseAntigravityUsageFromText } from '../src/lib/real-agents/antigravity-context';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import assert from 'node:assert/strict';
import { buildLiveRoomFootnotes, formatContextUsage } from '../src/lib/live-room-footnotes';
import { normalizeMemberModelSettings } from '../src/lib/live-room-codex-settings';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import { buildAssistantRelayCard } from '../src/lib/feishu-live-room-relay';
import type { NormalizedContextUsage } from '../src/lib/harness/types';
import type { LiveRoomMessagePayload } from '../src/lib/live-room-types';

const now = Date.now();
const usage: NormalizedContextUsage = { usedTokens: 50, contextWindow: 100, outputTokens: 5,
  metricKind: 'turn_input', confidence: 'measured_exact', sessionId: 'a', collectedAt: now, model: 'reported-model' };
const snapshot = (patch: Partial<NormalizedContextUsage> = {}, sessionId = 'a') => buildLiveRoomFootnotes({
  participantId: 'participant',
  metadata: JSON.stringify({ lastSessionId: sessionId, contextUsage: { ...usage, ...patch },
    runtimeExecution: { id: 'execution', participantId: 'participant', startedAt: now - 1000, completedAt: now },
    runtimeState: { executionId: 'execution', sessionId: 'a', model: 'reported-model', modelKind: 'model_id',
      reasoning: { kind: 'unknown' }, evidence: 'runner', source: 'test', observedAt: now },
  }),
  model: 'requested-model', reasoningEffort: 'high', startedAt: now - 1000, now,
});
assert.match(snapshot().join('\n'), /reported-model.*实际值未确认.*requested-model/);
assert.match(snapshot()[1], /最近一轮输入：50 \/ 100 tokens \(50%\)/);
assert.match(snapshot()[2], /输入 50 \/ 输出 5 tokens · 耗时 1.0秒/);
assert.match(snapshot({ confidence: 'assumed_window' })[1], /50 \/ 100 tokens \(50%\) · 窗口未确认/);
assert.match(snapshot({ confidence: 'inferred_text' })[1], /50 \/ 100 tokens \(50%\) · 文本推断/);
assert.match(snapshot({ contextWindow: undefined })[1], /50 \/ 1,000,000 tokens \(0%\) · 按默认 1M 窗口估算/);
assert.doesNotMatch(snapshot({ metricKind: 'cumulative' })[1], /%|\/ 100/);
assert.match(snapshot({ usedTokens: 85, totalTokens: 500 })[1], /对话历史累计：500 tokens \(窗口当量 500%\)/);
assert.match(snapshot({ usedTokens: 85, totalTokens: 500 })[2], /⚠️ 当前上下文已占用 85%/);
assert.match(snapshot({ metricKind: 'cumulative', usedTokens: 85 })[1], /本次运行累计输入：85 tokens/);
assert.doesNotMatch(snapshot({ metricKind: 'cumulative', usedTokens: 85 }).join('\n'), /建议发送/);
for (const patch of [{ collectedAt: now - 900_001 }, { collectedAt: now - 1001 }, { outputTokens: -1 }, { usedTokens: NaN }]) {
  assert.match(snapshot(patch)[1], /未知/);
}
assert.match(snapshot({}, 'other')[1], /未知/);
assert.match(formatContextUsage({ ...usage, usedTokens: 0 }), /0 \/ 100/);
const saved = JSON.stringify(snapshot());
snapshot({ model: 'different-model', sessionId: 'b' }, 'b');
assert.equal(JSON.stringify(snapshot()), saved, 'other member/session cannot rewrite a saved snapshot');

assert.deepEqual(normalizeMemberModelSettings({ model: 'new-model', reasoningEffort: 'HIGH' }, 'antigravity', 'platform_local'), { model: 'new-model', reasoningEffort: 'high' });
assert.equal(normalizeMemberModelSettings({ model: 'kimi' }, 'kimi-code', 'platform_local').model, 'kimi');
assert.equal(normalizeMemberModelSettings({ reasoningEffort: 'xhigh' }, 'codex', 'platform_local').reasoningEffort, 'xhigh');
assert.deepEqual(normalizeMemberModelSettings({ model: '', reasoningEffort: null }, 'codex'), { model: null, reasoningEffort: null });
for (const [input, harness, backend] of [
  [{ model: 3 }, 'codex', 'platform_local'], [{ reasoningEffort: {} }, 'codex', 'platform_local'],
  [{ model: '--bad model' }, 'codex', 'platform_local'], [{ reasoningEffort: 'ultra' }, 'antigravity', 'platform_local'],
  [{ reasoningEffort: 'high' }, 'kimi-code', 'platform_local'], [{ model: 'x' }, 'antigravity', 'remote_ssh'],
  [{ model: 'x' }, 'unknown', 'platform_local'],
] as const) assert.throws(() => normalizeMemberModelSettings(input, harness, backend));

const footnotes = snapshot();
const tracker = new FeishuProgressTracker('test');
tracker.setFootnotes(footnotes);
// Inspect rendering without contacting Feishu.
const internals = tracker as unknown as { buildCard(): unknown; replyContent: unknown };
assert.match(JSON.stringify(internals.buildCard()), /reported-model/);
internals.replyContent = { text: 'answer', details: 'tools', usage: '' };
assert.match(JSON.stringify(internals.buildCard()), /窗口|50%/);
const card = buildAssistantRelayCard({ content: 'answer', senderName: 'Agent', metadata: { footnotes } } as unknown as LiveRoomMessagePayload);
assert.match(JSON.stringify(card), /reported-model/);
assert.match(JSON.stringify(card), /最近一轮输入/);
console.log('live-room footnotes and member settings tests passed');

assert.equal(parseFeishuCommand({ text: '/ap model-config --agent=antigravity --thinking=high', chatId: 'chat', chatType: 'p2p', messageId: 'message', senderOpenId: 'user', messageType: 'text', mentions: [], mentionNames: [] })?.command, 'model-config');

assert.equal(parseAntigravityUsageFromText('{"event":"result","result":{"usage":{"input_tokens":50,"output_tokens":7}}}')?.outputTokens, 7);
assert.equal(parseAntigravityUsageFromText('{"usage":{"input_tokens":50,"output_tokens":-7}}')?.outputTokens, undefined);
