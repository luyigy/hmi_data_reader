import type { NormalizedContextUsage } from './harness/types';
import { readLegacyContextUsage } from './context-usage-legacy';
import { prisma } from './prisma';
import { parseJsonObject } from './acpx/runner-metadata';

const MAX_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
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
    || (usage.model !== undefined && (typeof usage.model !== 'string' || usage.model.length > 200))
    || (usage.outputTokens !== undefined && !nonNegative(usage.outputTokens))
    || (usage.totalTokens !== undefined && !nonNegative(usage.totalTokens))
    || (usage.contextWindow !== undefined && (!nonNegative(usage.contextWindow) || usage.contextWindow === 0))
    || (usage.isDefaultWindow !== undefined && typeof usage.isDefaultWindow !== 'boolean')
    || (usage.isDefaultWindow === true && usage.contextWindow !== DEFAULT_CONTEXT_WINDOW)
    || (usage.usagePercentage !== undefined && !nonNegative(usage.usagePercentage))) return null;
  return usage;
}

export function contextUsagePercentage(usage: NormalizedContextUsage | null): number | null {
  if (!usage || usage.metricKind === 'cumulative') return null;
  const percentage = usage.usedTokens / (usage.contextWindow || DEFAULT_CONTEXT_WINDOW) * 100;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

export async function persistContextUsage(participantId: string, usage: NormalizedContextUsage) {
  if (!usage.contextWindow) usage = { ...usage, contextWindow: DEFAULT_CONTEXT_WINDOW, isDefaultWindow: true };
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId }, select: { controlMetadata: true, harnessType: true,
      executionBackend: true, taskRun: { select: { taskId: true } } },
  });
  if (!participant) return;
  const metadata = parseJsonObject(participant.controlMetadata);
  if (participant.harnessType === 'antigravity' && usage.outputTokens !== undefined
    && usage.metricKind === 'cumulative' && usage.totalTokens === undefined
    && typeof metadata.continuationKey === 'string' && usage.sessionId) {
    const prior = await prisma.taskRunParticipant.findMany({
      where: { id: { not: participantId }, harnessType: 'antigravity',
        executionBackend: participant.executionBackend,
        taskRun: { taskId: participant.taskRun.taskId },
        AND: [
          { controlMetadata: { contains: JSON.stringify(usage.sessionId) } },
          { controlMetadata: { contains: `"continuationKey":${JSON.stringify(metadata.continuationKey)}` } },
        ] },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { controlMetadata: true },
    });
    const previous = prior.map(item => parseJsonObject(item.controlMetadata)).find(item =>
      item.continuationKey === metadata.continuationKey && item.lastSessionId === usage.sessionId);
    const previousUsage = previous?.contextUsage as NormalizedContextUsage | undefined;
    if (!previous || (previousUsage?.sessionId === usage.sessionId
      && nonNegative(previousUsage.totalTokens))) {
      usage = { ...usage, totalTokens: (previousUsage?.totalTokens || 0)
        + usage.usedTokens + usage.outputTokens };
    }
  }
  if (!readContextUsage(JSON.stringify({ ...metadata, contextUsage: usage }))) return;
  const current = readContextUsage(participant.controlMetadata);
  if (current && current.collectedAt > usage.collectedAt) return;
  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: { controlMetadata: JSON.stringify({ ...metadata, contextUsage: usage }) },
  });
}
