import { prisma } from '@/lib/prisma';

export type AntigravityContextUsage = {
  lastRunInputTokens: number;
  contextWindow: number | null;
  updatedAt: string;
  modelAlias?: string;
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'claude-3-5-sonnet': 200_000,
  'gpt-4o': 128_000,
};

export const resolveAntigravityContextWindow = (modelAlias?: string): number | null => {
  if (!modelAlias) return null;
  const key = modelAlias.toLowerCase().trim();
  for (const [pattern, windowSize] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key.includes(pattern)) return windowSize;
  }
  return null;
};

export const persistAntigravityContextUsageMetadata = async (
  participantId: string,
  usage: AntigravityContextUsage
) => {
  if (!participantId) return;
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: { controlMetadata: true },
  });
  if (!participant) return;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(participant.controlMetadata || '{}');
  } catch {
    /* ignore */
  }
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: JSON.stringify({
        ...metadata,
        antigravityContextUsage: usage,
      }),
    },
  });
};

export const getAntigravityProviderContextUsage = (
  value: string | null | undefined,
  now = new Date()
): {
  usagePercentage: number | null;
  lastRunInputTokens: number;
  contextWindow: number | null;
} | null => {
  if (!value) return null;
  try {
    const metadata = JSON.parse(value);
    if (!metadata || typeof metadata !== 'object') return null;
    const usage = metadata.antigravityContextUsage as
      | (AntigravityContextUsage & { usedTokens?: number })
      | undefined;
    if (!usage || typeof usage !== 'object') return null;

    const lastRunInputTokens = Number(usage.lastRunInputTokens ?? usage.usedTokens);
    const contextWindow = usage.contextWindow != null ? Number(usage.contextWindow) : null;

    if (!Number.isFinite(lastRunInputTokens) || lastRunInputTokens < 0) {
      return null;
    }

    if (usage.updatedAt) {
      const updatedAtMs = new Date(usage.updatedAt).getTime();
      if (Number.isNaN(updatedAtMs) || now.getTime() - updatedAtMs > MAX_AGE_MS) {
        return null;
      }
    }

    const usagePercentage =
      contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
        ? Math.max(0, Math.min(100, Math.round((lastRunInputTokens / contextWindow) * 100)))
        : null;

    return {
      usagePercentage,
      lastRunInputTokens,
      contextWindow,
    };
  } catch {
    return null;
  }
};

export const parseAntigravityUsageFromText = (
  text: string,
  options: { defaultContextWindow?: number; modelAlias?: string } = {}
): AntigravityContextUsage | null => {
  if (!text) return null;
  let detectedModel = options.modelAlias;

  try {
    // Attempt 1: Parse stream-json / json lines containing token usage
    const lines = text.split('\n');

    // First pass: extract model if present in init/event JSON
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (!detectedModel) {
          detectedModel = obj.model || obj.init?.model || obj.result?.model;
        }
      } catch {
        // continue
      }
    }

    const contextWindow =
      options.defaultContextWindow ?? resolveAntigravityContextWindow(detectedModel);

    // Second pass (backwards): find the latest result or step_update usage
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        const usageObj =
          obj.result?.usage ||
          obj.step_update?.usage ||
          obj.usage ||
          (obj.type === 'usage' ? obj : null);

        if (usageObj && typeof usageObj === 'object') {
          const inputTokens = Number(
            usageObj.input_tokens ?? usageObj.prompt_tokens ?? usageObj.inputTokens
          );
          if (Number.isFinite(inputTokens) && inputTokens >= 0) {
            return {
              lastRunInputTokens: inputTokens,
              contextWindow,
              updatedAt: new Date().toISOString(),
              ...(detectedModel ? { modelAlias: detectedModel } : {}),
            };
          }
        }
      } catch {
        // continue
      }
    }

    // Attempt 2: Match regex patterns in plaintext output
    const tokenMatch = text.match(/tokens?:\s*(\d+)/i) || text.match(/input_tokens?:\s*(\d+)/i);
    if (tokenMatch) {
      const lastRunInputTokens = parseInt(tokenMatch[1], 10);
      if (!Number.isNaN(lastRunInputTokens) && lastRunInputTokens >= 0) {
        return {
          lastRunInputTokens,
          contextWindow,
          updatedAt: new Date().toISOString(),
          ...(detectedModel ? { modelAlias: detectedModel } : {}),
        };
      }
    }
  } catch {
    // continue
  }

  return null;
};
