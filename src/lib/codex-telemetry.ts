import path from 'node:path';
import { prisma } from '@/lib/prisma';

const PROVIDER_USAGE_MAX_AGE_MS = 15 * 60 * 1000;
const QUOTA_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export type CodexTokenUsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexProviderTokenUsage = {
  source: 'codex_app_server';
  collectedAt: string;
  threadId: string;
  turnId: string;
  last: CodexTokenUsageBreakdown;
  total: CodexTokenUsageBreakdown;
  modelContextWindow: number;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

export type CodexQuotaSnapshot = {
  collectedAt: string;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

const quotaCache = new Map<string, CodexQuotaSnapshot>();

const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const parseBreakdown = (value: unknown): CodexTokenUsageBreakdown | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const inputTokens = finiteNumber(record.inputTokens);
  const totalTokens = finiteNumber(record.totalTokens);
  if (inputTokens === null || inputTokens < 0 || totalTokens === null || totalTokens < 0) return null;
  return {
    inputTokens,
    cachedInputTokens: finiteNumber(record.cachedInputTokens) ?? 0,
    outputTokens: finiteNumber(record.outputTokens) ?? 0,
    reasoningOutputTokens: finiteNumber(record.reasoningOutputTokens) ?? 0,
    totalTokens,
  };
};

export const parseCodexTokenUsage = (
  params: unknown,
  collectedAt = new Date()
): CodexProviderTokenUsage | null => {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  const tokenUsage = record.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const usage = tokenUsage as Record<string, unknown>;
  const last = parseBreakdown(usage.last);
  const total = parseBreakdown(usage.total);
  const modelContextWindow = finiteNumber(usage.modelContextWindow);
  if (
    typeof record.threadId !== 'string'
    || typeof record.turnId !== 'string'
    || !last
    || !total
    || modelContextWindow === null
    || modelContextWindow <= 0
  ) {
    return null;
  }
  return {
    source: 'codex_app_server',
    collectedAt: collectedAt.toISOString(),
    threadId: record.threadId,
    turnId: record.turnId,
    last,
    total,
    modelContextWindow,
  };
};

export const shouldReplaceCodexTokenUsage = (
  current: CodexProviderTokenUsage | null,
  next: CodexProviderTokenUsage
) => {
  if (!current) return true;
  const currentAt = Date.parse(current.collectedAt);
  const nextAt = Date.parse(next.collectedAt);
  if (!Number.isFinite(currentAt) || !Number.isFinite(current.total?.totalTokens)) return true;
  if (!Number.isFinite(nextAt) || nextAt < currentAt) return false;
  return current.threadId !== next.threadId
    || next.total.totalTokens >= current.total.totalTokens;
};

export const readCodexTokenUsageMetadata = (
  metadata: Record<string, unknown>,
  now = new Date()
) => {
  const usage = metadata.codexTokenUsage as CodexProviderTokenUsage | undefined;
  if (!usage || usage.source !== 'codex_app_server') return null;
  const collectedAt = Date.parse(usage.collectedAt);
  const currentThreadId = typeof metadata.codexThreadId === 'string'
    ? metadata.codexThreadId
    : null;
  if (
    !Number.isFinite(collectedAt)
    || collectedAt > now.getTime() + 60_000
    || now.getTime() - collectedAt > PROVIDER_USAGE_MAX_AGE_MS
    || (currentThreadId && currentThreadId !== usage.threadId)
    || !Number.isFinite(usage.last?.inputTokens)
    || !Number.isFinite(usage.modelContextWindow)
    || usage.modelContextWindow <= 0
  ) {
    return null;
  }
  return usage;
};

export const readCodexTokenUsageControlMetadata = (
  value: string | null | undefined,
  now = new Date()
) => {
  try {
    const metadata = JSON.parse(value || '{}');
    return metadata && typeof metadata === 'object'
      ? readCodexTokenUsageMetadata(metadata, now)
      : null;
  } catch {
    return null;
  }
};

export const getCodexProviderContextUsage = (
  value: string | null | undefined,
  now = new Date()
) => {
  const usage = readCodexTokenUsageControlMetadata(value, now);
  return usage
    ? {
        usagePercentage: Math.max(0, Math.min(100, Math.round(
          usage.last.inputTokens / usage.modelContextWindow * 100
        ))),
        usedTokens: usage.last.inputTokens,
        contextWindow: usage.modelContextWindow,
      }
    : null;
};

export const persistCodexTokenUsageMetadata = async (
  participantId: string,
  usage: CodexProviderTokenUsage
) => {
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: { controlMetadata: true },
  });
  if (!participant) return;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(participant.controlMetadata || '{}'); } catch { /* ignore */ }
  const current = metadata.codexTokenUsage as CodexProviderTokenUsage | undefined;
  if (!shouldReplaceCodexTokenUsage(current || null, usage)) return;
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: JSON.stringify({
        ...metadata,
        codexTokenUsage: usage,
      }),
    },
  });
};

const parseRateLimitWindow = (value: unknown): CodexRateLimitWindow | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent = finiteNumber(record.usedPercent);
  const windowDurationMins = finiteNumber(record.windowDurationMins);
  const resetsAt = finiteNumber(record.resetsAt);
  if (
    usedPercent === null
    || usedPercent < 0
    || usedPercent > 100
    || windowDurationMins === null
    || windowDurationMins <= 0
    || resetsAt === null
    || resetsAt <= 0
  ) return null;
  return { usedPercent, windowDurationMins, resetsAt };
};

export const getCodexAccountBoundary = (codexHome?: string) =>
  path.resolve(codexHome || process.env.CODEX_HOME?.trim() || path.join(process.cwd(), '.codex'));

export const updateCodexQuotaCache = ({
  codexHome,
  rateLimits,
  collectedAt = new Date(),
  snapshot = false,
}: {
  codexHome?: string;
  rateLimits: unknown;
  collectedAt?: Date;
  snapshot?: boolean;
}) => {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const record = rateLimits as Record<string, unknown>;
  const key = getCodexAccountBoundary(codexHome);
  const current = quotaCache.get(key);
  const nextCollectedAt = collectedAt.toISOString();
  if (current && Date.parse(nextCollectedAt) < Date.parse(current.collectedAt)) return current;
  const next: CodexQuotaSnapshot = {
    collectedAt: nextCollectedAt,
    primary: snapshot || Object.hasOwn(record, 'primary')
      ? parseRateLimitWindow(record.primary)
      : current?.primary ?? null,
    secondary: snapshot || Object.hasOwn(record, 'secondary')
      ? parseRateLimitWindow(record.secondary)
      : current?.secondary ?? null,
  };
  quotaCache.set(key, next);
  return next;
};

export const readCodexQuotaCache = (codexHome?: string, now = new Date()) => {
  const snapshot = quotaCache.get(getCodexAccountBoundary(codexHome));
  if (!snapshot) return null;
  const collectedAt = Date.parse(snapshot.collectedAt);
  return Number.isFinite(collectedAt)
    && collectedAt <= now.getTime() + 60_000
    && now.getTime() - collectedAt <= QUOTA_CACHE_MAX_AGE_MS
    ? snapshot
    : null;
};

export const clearCodexQuotaCacheForTests = () => quotaCache.clear();
