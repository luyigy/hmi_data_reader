import { prisma } from '@/lib/prisma';

export type AntigravityContextUsage = {
  usedTokens: number;
  contextWindow: number;
  updatedAt: string;
  modelAlias?: string;
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW = 1_048_576;

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
  usagePercentage: number;
  usedTokens: number;
  contextWindow: number;
} | null => {
  if (!value) return null;
  try {
    const metadata = JSON.parse(value);
    if (!metadata || typeof metadata !== 'object') return null;
    const usage = metadata.antigravityContextUsage as AntigravityContextUsage | undefined;
    if (!usage || typeof usage !== 'object') return null;

    const usedTokens = Number(usage.usedTokens);
    const contextWindow = Number(usage.contextWindow);

    if (
      !Number.isFinite(usedTokens) ||
      !Number.isFinite(contextWindow) ||
      usedTokens < 0 ||
      contextWindow <= 0
    ) {
      return null;
    }

    if (usage.updatedAt) {
      const updatedAtMs = new Date(usage.updatedAt).getTime();
      if (Number.isNaN(updatedAtMs) || now.getTime() - updatedAtMs > MAX_AGE_MS) {
        return null;
      }
    }

    const usagePercentage = Math.max(
      0,
      Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    );

    return {
      usagePercentage,
      usedTokens,
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
  const contextWindow = options.defaultContextWindow || DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW;

  try {
    // Attempt 1: Parse stream-json / json lines containing token usage
    const lines = text.split('\n');
    // Traverse backwards to find the latest/final result or step_update usage
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
              usedTokens: inputTokens,
              contextWindow,
              updatedAt: new Date().toISOString(),
              ...(options.modelAlias ? { modelAlias: options.modelAlias } : {}),
            };
          }
        }
      } catch {
        // continue
      }
    }
  } catch {
    // continue
  }

  // Attempt 2: Match regex patterns in plaintext output
  const tokenMatch = text.match(/tokens?:\s*(\d+)/i) || text.match(/input_tokens?:\s*(\d+)/i);
  if (tokenMatch) {
    const usedTokens = parseInt(tokenMatch[1], 10);
    if (!Number.isNaN(usedTokens) && usedTokens >= 0) {
      return {
        usedTokens,
        contextWindow,
        updatedAt: new Date().toISOString(),
        ...(options.modelAlias ? { modelAlias: options.modelAlias } : {}),
      };
    }
  }

  return null;
};
