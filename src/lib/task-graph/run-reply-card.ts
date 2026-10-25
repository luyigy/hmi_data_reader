import { redactSensitiveText } from '../redact-sensitive';
import { buildRunReplyCard as buildReplyCard } from '../task-run-reply-card';

function agentReply(response: string) {
  const control = /^TASK_GRAPH_(?:IMPLEMENTATION|CONVERSATION|REVIEW)\s+(\{[^\n]+\})\s*$/gm;
  const answer = response.replace(control, '').trim();
  if (answer) return answer;
  const parts: string[] = [];
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
  const card = buildReplyCard(run, history, requests, output, agentReply);
  if (run.status === 'failed') {
    const beforeStart = run.participants.length > 0 && run.participants.every(participant => {
      try { return participant.executionBackend === 'platform_local' && !JSON.parse(participant.controlMetadata || '{}').spawnedAt; }
      catch { return false; }
    });
    card.header.title.content = card.header.title.content.replace('执行失败', beforeStart ? '启动前失败' : '会话执行失败');
  }
  const toolFailures = history.filter(event => {
    try { const metadata = JSON.parse(event.metadata || '{}'); return metadata.kind === 'tool' && metadata.status === 'failed'; }
    catch { return false; }
  });
  if (toolFailures.length) card.body.elements.unshift({ tag: 'markdown', content: '工具失败记录（不等于正式验收失败）：\n' + toolFailures.map(event => event.content).join('\n').slice(0, 2000) });
  const failure = JSON.parse(run.controlMetadata || '{}').graphReplyFailure;
  if (failure?.kind === 'formal_acceptance' || failure?.kind === 'review_execution') {
    card.header.title.content = failure.kind === 'formal_acceptance' ? (failure.phase === 'architecture' ? '正式架构复核未通过' : '正式验收未通过') : '复核执行失败';
    card.body.elements.unshift({ tag: 'markdown', content: redactSensitiveText(String(failure.evidence)).slice(0, 2000) });
  }
  return card;
}
