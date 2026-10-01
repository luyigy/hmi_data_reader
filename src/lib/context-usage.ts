import type { NormalizedContextUsage } from './harness/types';
import { readLegacyContextUsage } from './context-usage-legacy';
import { prisma } from './prisma';
import { parseJsonObject } from './acpx/runner-metadata';

const MAX_AGE_MS = 15 * 60 * 1000;
const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function readContextUsage(value: string | null | undefined, now = Date.now()): NormalizedContextUsage | null {
  const metadata = parseJsonObject(value);
  // An invalid new record must not resurrect older telemetry.
  const usage = ('contextUsage' in metadata
    ? metadata.contextUsage
    : readLegacyContextUsage(metadata, now)) as NormalizedContextUsage | undefined;
  const sessionId = metadata.lastSessionId ?? metadata.codexThreadId;
  if (!usage || !nonNegative(usage.usedTokens)
    || !nonNegative(usage.collectedAt)
    || usage.collectedAt > now + 60_000 || now - usage.collectedAt > MAX_AGE_MS
    || typeof sessionId !== 'string' || !sessionId || usage.sessionId !== sessionId
    || !['turn_input', 'session_context', 'cumulative'].includes(usage.metricKind)
    || !['measured_exact', 'inferred_text', 'assumed_window'].includes(usage.confidence)
    || (usage.contextWindow !== undefined && (!nonNegative(usage.contextWindow) || usage.contextWindow === 0))
    || (usage.usagePercentage !== undefined && !nonNegative(usage.usagePercentage))) return null;
  return usage;
}

export function contextUsagePercentage(usage: NormalizedContextUsage | null): number | null {
  if (!usage || usage.metricKind === 'cumulative' || usage.confidence !== 'measured_exact') return null;
  const percentage = usage.contextWindow
    ? usage.usedTokens / usage.contextWindow * 100 : usage.usagePercentage;
  return percentage === undefined ? null : Math.max(0, Math.min(100, Math.round(percentage)));
}

export async function persistContextUsage(participantId: string, usage: NormalizedContextUsage) {
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId }, select: { controlMetadata: true },
  });
  if (!participant) return;
  const metadata = parseJsonObject(participant.controlMetadata);
  if (!readContextUsage(JSON.stringify({ ...metadata, contextUsage: usage }))) return;
  const current = readContextUsage(participant.controlMetadata);
  if (current && current.collectedAt > usage.collectedAt) return;
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: { controlMetadata: JSON.stringify({ ...metadata, contextUsage: usage }) },
  });
}
