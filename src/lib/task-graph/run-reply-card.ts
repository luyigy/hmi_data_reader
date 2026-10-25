import { buildRunReplyCard as buildReplyCard } from '../task-run-reply-card';

function agentReply(response: string) {
  const control = /^TASK_GRAPH_(?:IMPLEMENTATION|CONVERSATION|REVIEW)\s+(\{[^\n]+\})\s*$/gm;
  const parts = [response.replace(control, '').trim()];
  for (const block of Array.from(response.matchAll(control))) {
    try {
      const value: unknown = JSON.parse(block[1]);
      if (value && typeof value === 'object' && 'note' in value && typeof value.note === 'string' &&
        value.note.trim()) {
        const note = value.note.trim();
        if (!parts.some(part => part.includes(note))) parts.push(note);
      }
    } catch { /* Invalid controls are handled by the execution protocol, not card rendering. */ }
  }
  return parts.filter(Boolean).join('\n\n');
}

export function buildRunReplyCard(...[run, history, requests, output]: Parameters<typeof buildReplyCard>) {
  return buildReplyCard(run, history, requests, output, agentReply);
}
