export interface KimiCodeContextUsage {
  usedTokens: number;
  modelAlias?: string;
  protocolVersion?: string;
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
