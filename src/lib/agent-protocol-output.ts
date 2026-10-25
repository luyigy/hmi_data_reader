import type { AgentMessageInfo } from './agent-reply-state';

/** Protocol input has no display fallback: an explicitly phased turn needs one final message. */
export class AgentProtocolOutput {
  private messages = new Map<string, { text: string; phase: AgentMessageInfo['phase'] }>();

  append(text: string, message?: AgentMessageInfo) {
    if (!message) return;
    const before = this.messages.get(message.id);
    this.messages.set(message.id, {
      text: message.operation === 'replace' ? text : (before?.text || '') + text,
      phase: message.phase,
    });
  }

  finalOutput(legacyOutput: string): string | null {
    if (!this.messages.size) return legacyOutput;
    const finals = Array.from(this.messages.values()).filter(message => message.phase === 'final_answer');
    return finals.length === 1 ? finals[0].text : null;
  }
}
