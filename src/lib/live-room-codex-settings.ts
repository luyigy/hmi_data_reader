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

export const normalizeCodexMemberSettings = (input: {
  model?: unknown;
  reasoningEffort?: unknown;
}) => {
  const model = typeof input.model === 'string' ? input.model.trim() : undefined;
  const reasoningEffort = typeof input.reasoningEffort === 'string'
    ? input.reasoningEffort.trim().toLowerCase()
    : undefined;

  if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) {
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
