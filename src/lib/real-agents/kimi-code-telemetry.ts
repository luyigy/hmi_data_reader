import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { getKimiCodeHome } from './kimi-code-agent';
import { parseKimiCodeContextUsage } from './kimi-code-context';

const PROVIDER_USAGE_MAX_AGE_MS = 15 * 60 * 1000;
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
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const wirePath = path.join(
      home,
      'sessions',
      workspace.name,
      `session_${sessionId}`,
      'agents',
      'main',
      'wire.jsonl'
    );
    try {
      await access(wirePath);
      return wirePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
};

export const collectKimiCodeProviderContextUsage = async ({
  sessionId,
  home = getKimiCodeHome(),
  collectedAt = new Date(),
}: {
  sessionId: string;
  home?: string;
  collectedAt?: Date;
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
    const contextWindow = parseKimiCodeModelContextWindow(config, usage.modelAlias);
    if (!contextWindow) return null;
    return {
      source: 'kimi_wire',
      collectedAt: collectedAt.toISOString(),
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
