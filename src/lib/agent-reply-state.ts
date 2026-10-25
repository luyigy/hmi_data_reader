export type AgentMessageInfo = {
  id: string;
  phase: 'commentary' | 'partial_answer' | 'final_answer' | 'reasoning_summary' | null;
  operation?: 'append' | 'replace';
};

export function parseAgentMessageInfo(value: unknown): AgentMessageInfo | undefined {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id || !('phase' in value)) return;
  const phase = value.phase;
  if (phase !== null && phase !== 'commentary' && phase !== 'partial_answer' && phase !== 'final_answer' && phase !== 'reasoning_summary') return;
  return { id: value.id, phase, ...('operation' in value && value.operation === 'replace' ? { operation: 'replace' as const } : {}) };
}

export function latestReplyPreview(text: string, limit = 240) {
  const paragraph = text.trim().split(/\n\s*\n/).filter(Boolean).at(-1) || '';
  return paragraph.length > limit ? '…' + paragraph.slice(-(limit - 1)) : paragraph;
}

/** Display projection only. Execution output and control messages retain their original contract. */
export class AgentReplyState {
  private messages = new Map<string, { text: string; phase: AgentMessageInfo['phase'] }>();
  private legacy = '';
  append(text: string, message?: AgentMessageInfo) {
    if (!message) { this.legacy += text; return; }
    const before = this.messages.get(message.id);
    this.messages.set(message.id, { text: message.operation === 'replace' ? text : (before?.text || '') + text,
      phase: message.phase ?? before?.phase ?? null });
  }
  view(fallback = '') {
    const messages = Array.from(this.messages.values());
    const processEntries = [this.legacy, ...messages.filter(m => m.phase !== 'final_answer').map(m => m.text)].filter(Boolean);
    const process = processEntries.join('\n\n');
    const final = messages.filter(m => m.phase === 'final_answer').map(m => m.text).join('\n\n');
    const unknown = messages.some(m => m.phase === null) || !!this.legacy || !messages.length;
    return { process, processEntries, latest: latestReplyPreview(messages.at(-1)?.text || this.legacy),
      final: final || (unknown ? fallback : '本轮已结束，未收到独立的最终答复。请展开思考过程查看进展。') };
  }
}
