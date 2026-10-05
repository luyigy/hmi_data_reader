import { DEFAULT_CONTEXT_WINDOW, readContextUsage, contextUsagePercentage } from './context-usage';
import type { NormalizedContextUsage } from './harness/types';
import { readHarnessRuntimeState, formatHarnessRuntimeState } from './harness-runtime-state';
import { prisma } from './prisma';

export function formatContextUsage(usage: NormalizedContextUsage | null): string {
  if (!usage) return '上下文：未知（遥测缺失、过期或会话不匹配）';
  const label = { turn_input: '最近一轮输入', session_context: '会话上下文', cumulative: '本次运行累计输入' }[usage.metricKind];
  const percentage = contextUsagePercentage(usage);
  const window = usage.metricKind === 'cumulative' ? ''
    : ` / ${(usage.contextWindow || DEFAULT_CONTEXT_WINDOW).toLocaleString('en-US')}`;
  const confidence = !usage.contextWindow || usage.isDefaultWindow ? ' · 按默认 1M 窗口估算'
    : usage.confidence === 'assumed_window' ? ' · 窗口未确认'
    : usage.confidence === 'inferred_text' ? ' · 文本推断' : '';
  const windowSize = usage.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const totalPercentage = usage.totalTokens !== undefined && windowSize > 0
    ? Math.max(0, Math.round((usage.totalTokens / windowSize) * 100))
    : null;
  const total = usage.totalTokens === undefined ? ''
    : ` · 对话历史累计：${usage.totalTokens.toLocaleString('en-US')} tokens${totalPercentage === null ? '' : ` (窗口当量 ${totalPercentage}%)`}`;
  return `${label}：${usage.usedTokens.toLocaleString('en-US')}${window} tokens${percentage === null ? '' : ` (${percentage}%)`}${confidence}${total}`;
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
    ...(usage && (contextUsagePercentage(usage) ?? 0) >= 75
      ? [`⚠️ ${usage.contextWindow && !usage.isDefaultWindow ? '当前上下文' : '按默认窗口估算的上下文'}已占用 ${contextUsagePercentage(usage)}%，建议发送 /ap new-session 切换会话。`]
      : []),
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
