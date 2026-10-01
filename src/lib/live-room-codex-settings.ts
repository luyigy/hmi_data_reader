export const CODEX_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

// Pi selections share the existing model field as provider/model (model IDs may contain /).
export function splitPiModel(value?: string | null) {
  const selection = value?.trim() || '';
  const slash = selection.indexOf('/');
  return slash < 0
    ? { provider: '', model: selection }
    : { provider: selection.slice(0, slash), model: selection.slice(slash + 1) };
}

export function joinPiModel(provider: string, model: string) {
  provider = provider.trim();
  model = model.trim();
  if (provider && (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(provider) || !model)) {
    throw new Error('Invalid member Pi selection: 请填写有效 Provider 及其模型 ID；两项留空可继承默认值。');
  }
  if (!provider && model.includes('/')) throw new Error('Invalid member Pi selection: 模型 ID 含 / 时，请同时填写 Provider。');
  return provider ? `${provider}/${model}` : model;
}

export const normalizeCodexMemberSettings = (input: {
  model?: unknown;
  reasoningEffort?: unknown;
}) => {
  for (const value of [input.model, input.reasoningEffort]) {
    if (value != null && typeof value !== 'string') throw new Error('Invalid Codex setting type');
  }
  const model = typeof input.model === 'string' ? input.model.trim() : undefined;
  const reasoningEffort = typeof input.reasoningEffort === 'string'
    ? input.reasoningEffort.trim().toLowerCase()
    : undefined;

  if (model && (model.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(model))) {
    throw new Error('Invalid Codex model');
  }
  if (
    reasoningEffort
    && !CODEX_REASONING_EFFORTS.includes(reasoningEffort as typeof CODEX_REASONING_EFFORTS[number])
  ) {
    throw new Error('Invalid Codex reasoning effort');
  }

  return {
    model: model || null,
    reasoningEffort: reasoningEffort || null,
  };
};

// Reuse the existing member storage and execution parameters; no schema migration.
export function getMemberModelCapabilities(harness?: string | null, backend?: string | null) {
  if (backend === 'platform_local' && harness === 'pi-agent') return { model: true, efforts: [...PI_THINKING_LEVELS] as string[] };
  if (harness === 'codex') return { model: true, efforts: [...CODEX_REASONING_EFFORTS] as string[] };
  if (backend === 'platform_local' && harness === 'antigravity') {
    return { model: true, efforts: ['low', 'medium', 'high', 'max'] };
  }
  if (backend === 'platform_local' && harness === 'kimi-code') return { model: true, efforts: [] as string[] };
  return { model: false, efforts: [] as string[] };
}

export function normalizeMemberModelSettings(input: { model?: unknown; reasoningEffort?: unknown }, harness?: string | null, backend?: string | null) {
  const capabilities = getMemberModelCapabilities(harness, backend);
  if (!capabilities.model) throw new Error('Invalid member model settings: unsupported harness/backend');
  if (harness === 'pi-agent') {
    for (const value of [input.model, input.reasoningEffort]) {
      if (value != null && typeof value !== 'string') throw new Error('Invalid member setting type');
    }
    const model = (input.model as string | null | undefined)?.trim() || null;
    const reasoningEffort = (input.reasoningEffort as string | null | undefined)?.trim().toLowerCase() || null;
    if (model && (model.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/.test(model))) {
      throw new Error('Invalid member Pi model: use provider/model or a model ID');
    }
    if (reasoningEffort && !capabilities.efforts.includes(reasoningEffort)) throw new Error('Invalid member Pi thinking level');
    return { model, reasoningEffort };
  }
  const settings = normalizeCodexMemberSettings(input);
  if (settings.reasoningEffort && !capabilities.efforts.includes(settings.reasoningEffort)) {
    throw new Error('Invalid member reasoning effort');
  }
  return settings;
}
