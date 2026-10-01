import { readContextUsage, contextUsagePercentage } from './context-usage';
import type { NormalizedContextUsage } from './harness/types';
import { readHarnessRuntimeState, formatHarnessRuntimeState } from './harness-runtime-state';
import { prisma } from './prisma';

export function formatContextUsage(usage: NormalizedContextUsage | null): string {
  if (!usage) return '上下文：未知（遥测缺失、过期或会话不匹配）';
  const label = { turn_input: '最近一轮输入', session_context: '会话上下文', cumulative: '累计 token' }[usage.metricKind];
  const percentage = contextUsagePercentage(usage);
  const window = usage.contextWindow && usage.confidence === 'measured_exact' && usage.metricKind !== 'cumulative'
    ? ` / ${usage.contextWindow.toLocaleString('en-US')}` : '';
  const confidence = usage.confidence === 'assumed_window' ? ' · 窗口未确认'
    : usage.confidence === 'inferred_text' ? ' · 文本推断' : '';
  return `${label}：${usage.usedTokens.toLocaleString('en-US')}${window} tokens${percentage === null ? '' : ` (${percentage}%)`}${confidence}`;
}

export function buildLiveRoomFootnotes(input: {
  metadata?: string | null;
  participantId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  startedAt: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const candidate = readContextUsage(input.metadata, now);
  // A fresh record from an earlier turn is still not this turn's telemetry.
  const usage = candidate && candidate.collectedAt >= input.startedAt ? candidate : null;
  const runtimeState = readHarnessRuntimeState(input.metadata, { participantId: input.participantId, startedAt: input.startedAt, now });
  return [
    `${formatHarnessRuntimeState(runtimeState)}（本轮请求：${input.model || '继承默认'} · ${input.reasoningEffort || '继承默认'}）`,
    formatContextUsage(usage),
    `${usage?.metricKind === 'turn_input' ? `本轮输入 ${usage.usedTokens.toLocaleString('en-US')} / 输出 ${usage.outputTokens?.toLocaleString('en-US') ?? '未提供'} tokens` : '本轮 token 用量未提供'} · 耗时 ${Math.max(0, (now - input.startedAt) / 1000).toFixed(1)}秒`,
    ...(usage ? [`采集时间：${new Date(usage.collectedAt).toISOString()} · ${usage.metricKind} · ${usage.confidence}`] : []),
  ];
}

export async function collectLiveRoomFootnotes(input: Omit<Parameters<typeof buildLiveRoomFootnotes>[0], 'metadata'>) {
  const participant = input.participantId ? await prisma.taskRunParticipant.findUnique({
    where: { id: input.participantId }, select: { controlMetadata: true },
  }).catch((error) => {
    console.error('Failed to read reply telemetry:', error);
    return null;
  }) : null;
  return buildLiveRoomFootnotes({ ...input, metadata: participant?.controlMetadata });
}
