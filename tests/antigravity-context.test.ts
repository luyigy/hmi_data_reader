import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAntigravityProviderContextUsage,
  parseAntigravityUsageFromText,
  resolveAntigravityContextWindow,
  DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW,
} from '../src/lib/real-agents/antigravity-context';

describe('antigravity-context', () => {
  describe('resolveAntigravityContextWindow', () => {
    it('resolves specific context window by model alias', () => {
      assert.equal(resolveAntigravityContextWindow('gemini-1.5-pro'), 2_097_152);
      assert.equal(resolveAntigravityContextWindow('claude-3-5-sonnet'), 200_000);
      assert.equal(resolveAntigravityContextWindow('gpt-4o'), 128_000);
      assert.equal(resolveAntigravityContextWindow('unknown-model'), DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW);
      assert.equal(resolveAntigravityContextWindow(undefined), DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW);
    });
  });
  describe('getAntigravityProviderContextUsage', () => {
    it('returns null for empty or invalid metadata', () => {
      assert.equal(getAntigravityProviderContextUsage(null), null);
      assert.equal(getAntigravityProviderContextUsage(''), null);
      assert.equal(getAntigravityProviderContextUsage('{invalid json}'), null);
      assert.equal(getAntigravityProviderContextUsage('{}'), null);
    });

    it('calculates correct usage percentage for valid metadata', () => {
      const now = new Date();
      const metadata = JSON.stringify({
        antigravityContextUsage: {
          usedTokens: 600000,
          contextWindow: 1048576,
          updatedAt: now.toISOString(),
        },
      });

      const result = getAntigravityProviderContextUsage(metadata, now);
      assert.notEqual(result, null);
      assert.equal(result?.usedTokens, 600000);
      assert.equal(result?.contextWindow, 1048576);
      assert.equal(result?.usagePercentage, 57);
    });

    it('clamps percentage between 0 and 100', () => {
      const now = new Date();
      const metadataHigh = JSON.stringify({
        antigravityContextUsage: {
          usedTokens: 2000000,
          contextWindow: 1048576,
          updatedAt: now.toISOString(),
        },
      });
      const result = getAntigravityProviderContextUsage(metadataHigh, now);
      assert.equal(result?.usagePercentage, 100);
    });

    it('returns null if usage metadata has expired', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
      const metadata = JSON.stringify({
        antigravityContextUsage: {
          usedTokens: 500000,
          contextWindow: 1048576,
          updatedAt: pastDate.toISOString(),
        },
      });

      assert.equal(getAntigravityProviderContextUsage(metadata, now), null);
    });

    it('returns null for negative tokens or zero context window', () => {
      const now = new Date();
      const metadataInvalid = JSON.stringify({
        antigravityContextUsage: {
          usedTokens: -100,
          contextWindow: 0,
          updatedAt: now.toISOString(),
        },
      });
      assert.equal(getAntigravityProviderContextUsage(metadataInvalid, now), null);
    });
  });

  describe('parseAntigravityUsageFromText', () => {
    it('parses token usage from stream-json output', () => {
      const sampleOutput = `
{"type":"init","model":"gemini-1.5-pro"}
{"type":"step_update","content":"thinking"}
{"type":"usage","input_tokens":524288,"output_tokens":1024}
{"type":"result","status":"success"}
`;
      const usage = parseAntigravityUsageFromText(sampleOutput);
      assert.notEqual(usage, null);
      assert.equal(usage?.usedTokens, 524288);
      assert.equal(usage?.contextWindow, 2_097_152);
    });

    it('parses token usage from regex fallback in plain text', () => {
      const sampleText = 'Antigravity run completed. Tokens: 400000 / 1048576';
      const usage = parseAntigravityUsageFromText(sampleText);
      assert.notEqual(usage, null);
      assert.equal(usage?.usedTokens, 400000);
    });

    it('returns null if no usage information present', () => {
      assert.equal(parseAntigravityUsageFromText('Just normal text output'), null);
      assert.equal(parseAntigravityUsageFromText(''), null);
    });
  });
});
