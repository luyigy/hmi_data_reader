import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { getKimiCodeHome } from './kimi-code-agent';
import { parseKimiCodeContextUsage, parseKimiCodeSessionTelemetry } from './kimi-code-context';

const PROVIDER_USAGE_MAX_AGE_MS = 15 * 60 * 1000;
const QUOTA_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const KIMI_CODE_QUOTA_TIMEOUT_MS = 8_000;
const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type KimiCodeProviderContextUsage = {
  source: 'kimi_wire';
  collectedAt: string;
  sessionId: string;
  modelAlias: string;
  usedTokens: number;
  contextWindow: number;
  protocolVersion: string;
};

const parseTomlSectionName = (value: string) => {
  const quoted = value.match(/^"((?:\\.|[^"])*)"$/);
  if (quoted) {
    try {
      return JSON.parse(`"${quoted[1]}"`) as string;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
};

export const parseKimiCodeModelContextWindow = (
  config: string,
  modelAlias: string
): number | null => {
  let currentModel: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[models\.([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      currentModel = parseTomlSectionName(section[1].trim());
      continue;
    }
    if (currentModel !== modelAlias) continue;
    const setting = line.match(/^\s*max_context_size\s*=\s*([0-9][0-9_]*)\s*(?:#.*)?$/);
    if (!setting) continue;
    const value = Number(setting[1].replaceAll('_', ''));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
};

const findKimiCodeWirePath = async (home: string, sessionId: string) => {
  const workspaces = await readdir(path.join(home, 'sessions'), { withFileTypes: true });
  let found: string | null = null;
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const wirePath = path.join(
      home,
      'sessions',
      workspace.name,
      sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`,
      'agents',
      'main',
      'wire.jsonl'
    );
    try {
      await access(wirePath);
      if (found) return null;
      found = wirePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found;
};

export const collectKimiCodeSessionTelemetry = async ({
  sessionId, executionId, startedAt, completedAt, home = getKimiCodeHome(),
}: {
  sessionId: string; executionId: string; startedAt: number; completedAt: number; home?: string;
}) => {
  if (!SAFE_SESSION_ID.test(sessionId) || !executionId || !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt) || completedAt < startedAt) return;
  try {
    const wirePath = await findKimiCodeWirePath(home, sessionId);
    // ponytail: whole-file read caps at 64 MiB; use bounded tail parsing if larger sessions need telemetry.
    if (!wirePath || (await stat(wirePath)).size > 64 * 1024 * 1024) return;
    const wire = await readFile(wirePath, 'utf8');
    const scope = { executionId, sessionId, startedAt, completedAt };
    const telemetry = parseKimiCodeSessionTelemetry(wire, scope);
    if (!telemetry) return;
    let contextWindow: number | undefined;
    try {
      const config = await readFile(path.join(home, 'config.toml'), 'utf8');
      if (telemetry.modelAlias) contextWindow = parseKimiCodeModelContextWindow(config, telemetry.modelAlias) ?? undefined;
    } catch { /* Config is optional evidence; wire state remains valid. */ }
    return contextWindow ? parseKimiCodeSessionTelemetry(wire, { ...scope, contextWindow }) : telemetry;
  } catch {
    return;
  }
};

export const collectKimiCodeProviderContextUsage = async ({
  sessionId,
  home = getKimiCodeHome(),
}: {
  sessionId: string;
  home?: string;
}): Promise<KimiCodeProviderContextUsage | null> => {
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  try {
    const wirePath = await findKimiCodeWirePath(home, sessionId);
    if (!wirePath) return null;
    const [wire, config] = await Promise.all([
      readFile(wirePath, 'utf8'),
      readFile(path.join(home, 'config.toml'), 'utf8'),
    ]);
    const usage = parseKimiCodeContextUsage([wire]);
    if (!usage?.modelAlias || !usage.protocolVersion) return null;
    const ended = wire.split('\n').map(line => {
      try { return JSON.parse(line) as { type?: string; reason?: string; time?: number }; }
      catch { return null; }
    }).filter(record => record?.type === 'turn.ended' && record.reason === 'completed'
      && Number.isSafeInteger(record.time)).at(-1);
    if (!ended?.time) return null;
    const contextWindow = parseKimiCodeModelContextWindow(config, usage.modelAlias);
    if (!contextWindow) return null;
    return {
      source: 'kimi_wire',
      collectedAt: new Date(ended.time).toISOString(),
      sessionId,
      modelAlias: usage.modelAlias,
      usedTokens: usage.usedTokens,
      contextWindow,
      protocolVersion: usage.protocolVersion,
    };
  } catch {
    return null;
  }
};

const validUsageNumber = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const readKimiCodeContextUsageMetadata = (
  metadata: Record<string, unknown>,
  now = new Date()
) => {
  const usage = metadata.kimiCodeContextUsage as KimiCodeProviderContextUsage | undefined;
  const currentSessionId = typeof metadata.lastSessionId === 'string'
    ? metadata.lastSessionId
    : null;
  const currentSessionKind = metadata.lastSessionKind;
  const collectedAt = Date.parse(usage?.collectedAt || '');
  if (
    !usage
    || usage.source !== 'kimi_wire'
    || !currentSessionId
    || currentSessionKind !== 'kimi_session'
    || currentSessionId !== usage.sessionId
    || !usage.modelAlias
    || !usage.protocolVersion
    || !Number.isFinite(collectedAt)
    || collectedAt > now.getTime() + 60_000
    || now.getTime() - collectedAt > PROVIDER_USAGE_MAX_AGE_MS
    || !validUsageNumber(usage.usedTokens)
    || !validUsageNumber(usage.contextWindow)
    || usage.contextWindow <= 0
  ) {
    return null;
  }
  return usage;
};

export const getKimiCodeProviderContextUsage = (
  value: string | null | undefined,
  now = new Date()
) => {
  try {
    const metadata = JSON.parse(value || '{}');
    const usage = metadata && typeof metadata === 'object'
      ? readKimiCodeContextUsageMetadata(metadata, now)
      : null;
    return usage
      ? {
          usagePercentage: Math.max(0, Math.min(100, Math.round(
            usage.usedTokens / usage.contextWindow * 100
          ))),
          usedTokens: usage.usedTokens,
          contextWindow: usage.contextWindow,
        }
      : null;
  } catch {
    return null;
  }
};

export const shouldReplaceKimiCodeContextUsage = (
  current: KimiCodeProviderContextUsage | null,
  next: KimiCodeProviderContextUsage
) => {
  if (!current) return true;
  const currentAt = Date.parse(current.collectedAt);
  const nextAt = Date.parse(next.collectedAt);
  if (!Number.isFinite(currentAt)) return true;
  return Number.isFinite(nextAt) && nextAt >= currentAt;
};

export const persistKimiCodeContextUsageMetadata = async (
  participantId: string,
  usage: KimiCodeProviderContextUsage
) => {
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: { controlMetadata: true },
  });
  if (!participant) return;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(participant.controlMetadata || '{}'); } catch { /* ignore */ }
  const current = metadata.kimiCodeContextUsage as KimiCodeProviderContextUsage | undefined;
  if (!shouldReplaceKimiCodeContextUsage(current || null, usage)) return;
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: JSON.stringify({
        ...metadata,
        kimiCodeContextUsage: usage,
      }),
    },
  });
};

export type KimiCodeQuotaWindow = {
  duration: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
};

export type KimiCodeQuotaRow = {
  used: number;
  limit: number;
  resetAt?: string;
  window: KimiCodeQuotaWindow;
};

export type KimiCodeQuotaResult =
  | {
      status: 'available';
      collectedAt: string;
      summary: KimiCodeQuotaRow | null;
      limits: KimiCodeQuotaRow[];
    }
  | { status: 'unknown' };

const quotaCache = new Map<string, Extract<KimiCodeQuotaResult, { status: 'available' }>>();
const quotaRequests = new Map<string, Promise<KimiCodeQuotaResult>>();

const parseTomlString = (value: string | undefined) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

const parseManagedKimiCodeConfig = (config: string) => {
  let section = '';
  let defaultModel: string | null = null;
  let managedBaseUrl: string | null = null;
  let oauthKey: string | null = null;
  let defaultModelProvider: string | null = null;

  for (const line of config.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const setting = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!setting) continue;
    const [, key, rawValue] = setting;
    if (!section && key === 'default_model') {
      defaultModel = parseTomlString(rawValue);
      continue;
    }
    if (section === 'providers."managed:kimi-code"') {
      if (key === 'base_url') managedBaseUrl = parseTomlString(rawValue);
      if (key === 'oauth') {
        oauthKey = parseTomlString(rawValue.match(/\bkey\s*=\s*("(?:\\.|[^"])*")/)?.[1]);
      }
      continue;
    }
    if (section === 'providers."managed:kimi-code".oauth' && key === 'key') {
      oauthKey = parseTomlString(rawValue);
      continue;
    }
    if (defaultModel && section === `models.${JSON.stringify(defaultModel)}` && key === 'provider') {
      defaultModelProvider = parseTomlString(rawValue);
    }
  }

  return { defaultModelProvider, managedBaseUrl, oauthKey };
};

const normalizedManagedBaseUrl = (value: string | null) => {
  const expected = (process.env.KIMI_CODE_BASE_URL?.trim() || DEFAULT_KIMI_CODE_BASE_URL)
    .replace(/\/+$/, '');
  try {
    const expectedUrl = new URL(expected);
    const candidateUrl = new URL(value || '');
    if (
      expectedUrl.protocol !== 'https:'
      || candidateUrl.protocol !== 'https:'
      || expectedUrl.username
      || expectedUrl.password
      || candidateUrl.username
      || candidateUrl.password
    ) {
      return null;
    }
    const normalize = (url: URL) =>
      `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
    return normalize(candidateUrl) === normalize(expectedUrl) ? expected : null;
  } catch {
    return null;
  }
};

const tokenStorageName = (oauthKey: string | null) => {
  const key = oauthKey || 'kimi-code';
  const name = key.startsWith('oauth/') ? key.slice('oauth/'.length) : key;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : null;
};

const readKimiCodeQuotaAuth = async (home: string, now: Date) => {
  try {
    const config = parseManagedKimiCodeConfig(
      await readFile(path.join(home, 'config.toml'), 'utf8')
    );
    if (config.defaultModelProvider !== 'managed:kimi-code') return null;
    const baseUrl = normalizedManagedBaseUrl(config.managedBaseUrl);
    const storageName = tokenStorageName(config.oauthKey);
    if (!baseUrl || !storageName) return null;
    const credential = JSON.parse(
      await readFile(path.join(home, 'credentials', `${storageName}.json`), 'utf8')
    ) as Record<string, unknown>;
    const accessToken = typeof credential.access_token === 'string'
      ? credential.access_token
      : '';
    const expiresAt = credential.expires_at;
    if (
      !accessToken
      || typeof expiresAt !== 'number'
      || !Number.isFinite(expiresAt)
      || expiresAt * 1000 <= now.getTime()
    ) {
      return null;
    }
    return {
      accessToken,
      baseUrl,
      boundary: `${path.resolve(home)}:${createHash('sha256').update(accessToken).digest('hex')}`,
    };
  } catch {
    return null;
  }
};

const nonNegativeInt = (value: unknown) => {
  const number = typeof value === 'string' && value.trim()
    ? Number(value)
    : value;
  return typeof number === 'number'
    && Number.isSafeInteger(number)
    && number >= 0
    ? number
    : null;
};

const parseResetAt = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

const parseQuotaWindow = (value: unknown): KimiCodeQuotaWindow | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const duration = nonNegativeInt(record.duration);
  const units = {
    TIME_UNIT_MINUTE: 'minute',
    TIME_UNIT_HOUR: 'hour',
    TIME_UNIT_DAY: 'day',
    TIME_UNIT_WEEK: 'week',
  } as const;
  const unit = typeof record.timeUnit === 'string'
    ? units[record.timeUnit as keyof typeof units]
    : undefined;
  if (!duration || !unit) return null;
  return unit === 'minute' && duration >= 60 && duration % 60 === 0
    ? { duration: duration / 60, unit: 'hour' }
    : { duration, unit };
};

const parseQuotaRow = (
  value: unknown,
  window: KimiCodeQuotaWindow
): KimiCodeQuotaRow | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const used = nonNegativeInt(record.used);
  const limit = nonNegativeInt(record.limit);
  if (used === null || limit === null) return null;
  const resetAt = parseResetAt(record.resetTime);
  return {
    used,
    limit,
    window,
    ...(resetAt ? { resetAt } : {}),
  };
};

export const parseKimiCodeQuotaPayload = (value: unknown) => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const summary = parseQuotaRow(record.usage, { duration: 1, unit: 'week' });
  const limits = Array.isArray(record.limits)
    ? record.limits.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const limit = item as Record<string, unknown>;
        const window = parseQuotaWindow(limit.window);
        const row = window ? parseQuotaRow(limit.detail, window) : null;
        return row ? [row] : [];
      })
    : [];
  return summary || limits.length ? { summary, limits } : null;
};

const fetchKimiCodeQuota = async ({
  accessToken,
  baseUrl,
  collectedAt,
  fetchImpl,
  timeoutMs,
}: {
  accessToken: string;
  baseUrl: string;
  collectedAt: Date;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<KimiCodeQuotaResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/usages`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'unknown' };
    const parsed = parseKimiCodeQuotaPayload(await response.json());
    return parsed
      ? { status: 'available', collectedAt: collectedAt.toISOString(), ...parsed }
      : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  } finally {
    clearTimeout(timeout);
  }
};

export const getKimiCodeAccountQuota = async ({
  home = getKimiCodeHome(),
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = KIMI_CODE_QUOTA_TIMEOUT_MS,
}: {
  home?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<KimiCodeQuotaResult> => {
  const auth = await readKimiCodeQuotaAuth(home, now);
  if (!auth) return { status: 'unknown' };
  const cached = quotaCache.get(auth.boundary);
  const cachedAt = Date.parse(cached?.collectedAt || '');
  if (
    cached
    && Number.isFinite(cachedAt)
    && cachedAt <= now.getTime() + 60_000
    && now.getTime() - cachedAt <= QUOTA_CACHE_MAX_AGE_MS
  ) {
    return cached;
  }
  const pending = quotaRequests.get(auth.boundary);
  if (pending) return pending;
  const request = fetchKimiCodeQuota({
    accessToken: auth.accessToken,
    baseUrl: auth.baseUrl,
    collectedAt: now,
    fetchImpl,
    timeoutMs,
  }).then((result) => {
    const current = quotaCache.get(auth.boundary);
    if (
      result.status === 'available'
      && (!current || Date.parse(result.collectedAt) >= Date.parse(current.collectedAt))
    ) {
      quotaCache.set(auth.boundary, result);
    }
    return result;
  }).finally(() => quotaRequests.delete(auth.boundary));
  quotaRequests.set(auth.boundary, request);
  return request;
};

export const clearKimiCodeQuotaCacheForTests = () => {
  quotaCache.clear();
  quotaRequests.clear();
};
