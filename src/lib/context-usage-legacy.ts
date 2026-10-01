import { readCodexTokenUsageMetadata } from './codex-telemetry';
import { readKimiCodeContextUsageMetadata } from './real-agents/kimi-code-telemetry';
import type { NormalizedContextUsage } from './harness/types';

// Historical formats are read only here. New runs write contextUsage.
export function readLegacyContextUsage(
  metadata: Record<string, unknown>, now: number,
): NormalizedContextUsage | undefined {
  const codex = readCodexTokenUsageMetadata(metadata, new Date(now));
  if (codex) return {
    usedTokens: codex.last.inputTokens, contextWindow: codex.modelContextWindow,
    metricKind: 'turn_input', confidence: 'measured_exact',
    sessionId: codex.threadId, collectedAt: Date.parse(codex.collectedAt),
  };
  const kimi = readKimiCodeContextUsageMetadata(metadata, new Date(now));
  if (kimi) return {
    usedTokens: kimi.usedTokens, contextWindow: kimi.contextWindow,
    metricKind: 'session_context', confidence: 'assumed_window',
    sessionId: kimi.sessionId, collectedAt: Date.parse(kimi.collectedAt),
  };
  // Old Antigravity records have neither session binding nor provenance;
  // they cannot establish the current session's watermark.
  return undefined;
}
