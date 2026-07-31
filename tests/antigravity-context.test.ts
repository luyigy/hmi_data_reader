import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAntigravityProviderContextUsage,
  parseAntigravityUsageFromText,
  resolveAntigravityContextWindow,
} from '../src/lib/real-agents/antigravity-context';

describe('antigravity-context', () => {
  describe('resolveAntigravityContextWindow', () => {
    it('resolves specific context window by model alias and returns null when model is unknown', () => {
      assert.equal(resolveAntigravityContextWindow('gemini-1.5-pro'), 2_097_152);
      assert.equal(resolveAntigravityContextWindow('claude-3-5-sonnet'), 200_000);
      assert.equal(resolveAntigravityContextWindow('gpt-4o'), 128_000);
      assert.equal(resolveAntigravityContextWindow('unknown-model'), null);
      assert.equal(resolveAntigravityContextWindow(undefined), null);
    });
  });

  describe('getAntigravityProviderContextUsage', () => {
    it('returns null for empty or invalid metadata', () => {
      assert.equal(getAntigravityProviderContextUsage(null), null);
      assert.equal(getAntigravityProviderContextUsage(''), null);
      assert.equal(getAntigravityProviderContextUsage('{invalid json}'), null);
      assert.equal(getAntigravityProviderContextUsage('{}'), null);
    });

    it('returns usagePercentage null when contextWindow is null (unknown model)', () => {
      const now = new Date();
      const metadata = JSON.stringify({
        antigravityContextUsage: {
          lastRunInputTokens: 16223,
          contextWindow: null,
          updatedAt: now.toISOString(),
        },
      });

      const result = getAntigravityProviderContextUsage(metadata, now);
      assert.notEqual(result, null);
      assert.equal(result?.lastRunInputTokens, 16223);
      assert.equal(result?.contextWindow, null);
      assert.equal(result?.usagePercentage, null);
    });

    it('calculates correct usage percentage when contextWindow is known', () => {
      const now = new Date();
      const metadata = JSON.stringify({
        antigravityContextUsage: {
          lastRunInputTokens: 600000,
          contextWindow: 1048576,
          updatedAt: now.toISOString(),
        },
      });

      const result = getAntigravityProviderContextUsage(metadata, now);
      assert.notEqual(result, null);
      assert.equal(result?.lastRunInputTokens, 600000);
      assert.equal(result?.contextWindow, 1048576);
      assert.equal(result?.usagePercentage, 57);
    });

    it('returns null if usage metadata has expired', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
      const metadata = JSON.stringify({
        antigravityContextUsage: {
          lastRunInputTokens: 500000,
          contextWindow: 1048576,
          updatedAt: pastDate.toISOString(),
        },
      });

      assert.equal(getAntigravityProviderContextUsage(metadata, now), null);
    });

    it('returns null for negative tokens', () => {
      const now = new Date();
      const metadataInvalid = JSON.stringify({
        antigravityContextUsage: {
          lastRunInputTokens: -100,
          contextWindow: 1048576,
          updatedAt: now.toISOString(),
        },
      });
      assert.equal(getAntigravityProviderContextUsage(metadataInvalid, now), null);
    });
  });

  describe('parseAntigravityUsageFromText', () => {
    it('parses real agy 1.1.8 stream-json output without model and asserts contextWindow is null', () => {
      const realAgyStreamJsonOutput = `
{"event":"init","conversation_id":"9e46098e-80b5-4d1e-8166-733bea530b97","init":{"cwd":"/data1/code/agent-platform-v2","tools":["ask_permission"],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"9e46098e-80b5-4d1e-8166-733bea530b97","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"9e46098e-80b5-4d1e-8166-733bea530b97","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Hello! How can I help you today?","duration_seconds":2.12,"usage":{"input_tokens":16130,"output_tokens":47,"thinking_tokens":35,"cache_read_tokens":8154,"total_tokens":16177}}}
{"event":"result","result":{"conversation_id":"9e46098e-80b5-4d1e-8166-733bea530b97","status":"SUCCESS","response":"Hello! How can I help you today?\\n","duration_seconds":2.89,"num_turns":1,"usage":{"input_tokens":16223,"output_tokens":51,"thinking_tokens":35,"cache_read_tokens":8154,"total_tokens":16274}}}
`;
      const usage = parseAntigravityUsageFromText(realAgyStreamJsonOutput);
      assert.notEqual(usage, null);
      assert.equal(usage?.lastRunInputTokens, 16223);
      assert.equal(usage?.contextWindow, null);

      // Verify that getAntigravityProviderContextUsage returns usagePercentage null when contextWindow is null
      const formatted = getAntigravityProviderContextUsage(
        JSON.stringify({ antigravityContextUsage: usage })
      );
      assert.notEqual(formatted, null);
      assert.equal(formatted?.lastRunInputTokens, 16223);
      assert.equal(formatted?.contextWindow, null);
      assert.equal(formatted?.usagePercentage, null);
    });

    it('resolves contextWindow when modelAlias is explicitly provided', () => {
      const sampleOutput = `
{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"ok","usage":{"input_tokens":524288}}}
`;
      const usage = parseAntigravityUsageFromText(sampleOutput, { modelAlias: 'gemini-1.5-pro' });
      assert.notEqual(usage, null);
      assert.equal(usage?.lastRunInputTokens, 524288);
      assert.equal(usage?.contextWindow, 2_097_152);

      const formatted = getAntigravityProviderContextUsage(
        JSON.stringify({ antigravityContextUsage: usage })
      );
      assert.equal(formatted?.usagePercentage, 25);
    });

    it('returns null if no usage information present', () => {
      assert.equal(parseAntigravityUsageFromText('Just normal text output'), null);
      assert.equal(parseAntigravityUsageFromText(''), null);
    });
  });
});
