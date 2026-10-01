export interface KimiCodeContextUsage {
  usedTokens: number;
  modelAlias?: string;
  protocolVersion?: string;
}

import type { HarnessRuntimeState, NormalizedContextUsage } from '@/lib/harness/types';

export function parseKimiCodeSessionTelemetry(wire: string, scope: {
  executionId: string; sessionId: string; startedAt: number; completedAt: number;
  contextWindow?: number;
}): { runtimeState: HarnessRuntimeState; contextUsage?: NormalizedContextUsage; modelAlias?: string } | undefined {
  let promptAt = -1;
  let request: Record<string, unknown> | undefined;
  let usedTokens: number | undefined;
  let endedAt = -1;
  let turnId: string | undefined;
  for (const line of wire.split('\n')) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.time !== 'number' || !Number.isSafeInteger(record.time)
      || record.time < scope.startedAt || record.time > scope.completedAt
      || (record.agentId !== undefined && record.agentId !== 'main')) continue;
    if (record.type === 'turn.prompt') {
      promptAt = record.time;
      request = undefined;
      usedTokens = undefined;
      endedAt = -1;
      turnId = undefined;
    } else if (promptAt >= 0 && endedAt < 0 && record.time >= promptAt && record.type === 'llm.request') {
      request = record;
    } else if (promptAt >= 0 && record.time >= promptAt
      && record.type === 'context.append_loop_event') {
      const event = record.event as Record<string, unknown> | undefined;
      if (event?.type !== 'step.end' || !event.usage || typeof event.usage !== 'object') continue;
      const usage = event.usage as Record<string, unknown>;
      const values = ['inputCacheRead', 'inputCacheCreation', 'inputOther', 'output'].map(key => usage[key]);
      if (values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        usedTokens = (values as number[]).reduce((sum, value) => sum + value, 0);
      }
    } else if (promptAt >= 0 && record.time >= promptAt && record.type === 'context.clear') {
      usedTokens = 0;
    } else if (promptAt >= 0 && record.time >= promptAt
      && (record.type === 'context.update_token_count' || record.type === 'context.apply_compaction')) {
      const value = record.type === 'context.update_token_count' ? record.tokenCount : record.tokensAfter;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usedTokens = value;
    } else if (promptAt >= 0 && record.time >= promptAt && record.type === 'turn.ended') {
      if (record.reason !== 'completed' || !Number.isSafeInteger(record.turnId)) return;
      endedAt = record.time;
      turnId = String(record.turnId);
    }
  }
  if (!request || endedAt < 0 || (request.time as number) > endedAt) return;
  const validText = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
  const model = validText(request.model) ? request.model
    : validText(request.modelAlias) ? request.modelAlias : undefined;
  const effort = request.thinkingEffort;
  const runtimeState: HarnessRuntimeState = {
    executionId: scope.executionId, sessionId: scope.sessionId, turnId,
    ...(model ? { model, modelKind: validText(request.model) ? 'model_id' as const : 'alias' as const } : {}),
    reasoning: effort === 'off' || effort === false ? { kind: 'toggle', enabled: false }
      : effort === true ? { kind: 'toggle', enabled: true }
      : validText(effort) ? { kind: 'level', value: effort } : { kind: 'unknown' },
    source: 'kimi_wire.llm.request', evidence: 'runner', observedAt: request.time as number,
  };
  const contextUsage = usedTokens === undefined ? undefined : {
    usedTokens, metricKind: 'session_context' as const,
    confidence: 'assumed_window' as const, sessionId: scope.sessionId,
    collectedAt: endedAt,
    ...(scope.contextWindow ? { contextWindow: scope.contextWindow } : {}),
    ...(model ? { model } : {}),
  };
  return { runtimeState, ...(contextUsage ? { contextUsage } : {}),
    ...(validText(request.modelAlias) ? { modelAlias: request.modelAlias } : {}) };
}

const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const parseKimiCodeContextUsage = (
  chunks: readonly string[]
): KimiCodeContextUsage | null => {
  let buffer = '';
  let usedTokens: number | null = null;
  let modelAlias: string | undefined;
  let protocolVersion: string | undefined;
  let invalid = false;

  const parseLine = (line: string) => {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      invalid = true;
      return;
    }

    if (record.type === 'metadata' && typeof record.protocol_version === 'string') {
      protocolVersion = record.protocol_version;
      return;
    }
    if (record.type === 'config.update' && typeof record.modelAlias === 'string') {
      modelAlias = record.modelAlias.trim() || undefined;
      return;
    }
    if (record.type === 'context.clear') {
      usedTokens = 0;
      return;
    }
    if (record.type === 'context.update_token_count') {
      const value = tokenCount(record.tokenCount);
      if (value === null) invalid = true;
      else usedTokens = value;
      return;
    }
    if (record.type === 'context.apply_compaction') {
      const value = tokenCount(record.tokensAfter);
      if (value === null) invalid = true;
      else usedTokens = value;
      return;
    }
    if (record.type !== 'context.append_loop_event') return;

    const event = record.event;
    if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'step.end') {
      return;
    }
    if (!('usage' in event) || event.usage === undefined) return;
    if (!event.usage || typeof event.usage !== 'object') {
      invalid = true;
      return;
    }

    const usage = event.usage as Record<string, unknown>;
    const values = ['inputCacheRead', 'inputCacheCreation', 'inputOther', 'output']
      .map((key) => tokenCount(usage[key]));
    if (values.some((value) => value === null)) {
      invalid = true;
      return;
    }
    const fill = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (fill > 0) usedTokens = fill;
  };

  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) parseLine(line);
    }
  }
  if (buffer.trim()) parseLine(buffer);

  if (invalid || usedTokens === null) return null;
  return {
    usedTokens,
    ...(modelAlias ? { modelAlias } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
  };
};
