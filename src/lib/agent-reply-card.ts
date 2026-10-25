import { boundFeishuCardText } from './feishu-card-markdown';
import { redactSensitiveText } from './redact-sensitive';
import { latestReplyPreview } from './agent-reply-state';

type Element = Record<string, unknown>;
export function mergeAgentReply(progress: string, final: string) {
  if (!final) return progress;
  if (!progress || final.includes(progress)) return final;
  if (progress.endsWith(final)) return [progress.slice(0, -final.length).trimEnd(), final].filter(Boolean).join('\n\n');
  return progress.includes(final) ? progress : `${progress}\n\n${final}`;
}
/** One visible reply layout for room streams and persisted Ticket streams. */
export function agentReplyElements(args: {
  text: string;
  textLimit?: number;
  notices?: Element[];
  details?: { title: string; text: string; limit?: number; plainText?: boolean }[];
  footer?: Element[];
}) {
  return [
    { tag: 'markdown', content: boundFeishuCardText(redactSensitiveText(args.text), args.textLimit || 18_000, 'end') },
    ...(args.notices || []),
    ...(args.details || []).map(detail => ({ tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: detail.title } },
      elements: detail.plainText
        ? [{ tag: 'div', text: { tag: 'plain_text', content: boundFeishuCardText(redactSensitiveText(detail.text), detail.limit || 6000) } }]
        : [{ tag: 'markdown', content: boundFeishuCardText(redactSensitiveText(detail.text), detail.limit || 6000) }] })),
    ...(args.footer || []),
  ];
}

export function turnReplyElements(args: {
  active: boolean; latest: string; final: string; process: string; tools: string;
  processEntries?: string[]; processStarted?: string;
  notices?: Element[]; details?: { title: string; text: string; limit?: number }[];
  footnotes: string[]; schema?: '2.0';
}) {
  const clean = (text: string) => text.replace(/<(?:graph|room)-control>[\s\S]*?<\/(?:graph|room)-control>/g, '').trim();
  const footer = boundFeishuCardText(redactSensitiveText(args.footnotes.join('\n')), 2000);
  const process = [
    ...(args.processStarted ? [`🚀 ${args.processStarted}`] : []),
    ...(args.processEntries ?? [args.process]).map(clean).filter(Boolean).map(entry => `🧠 思考分析：${entry}`),
  ].join('\n\n');
  return agentReplyElements({
    textLimit: 12000,
    text: args.active ? latestReplyPreview(clean(args.latest)) || '正在准备执行…' : clean(args.final) || '本轮没有文字答复。',
    notices: args.notices,
    details: [
      { title: '思考过程', text: process || '暂无公开进展。', limit: 4000 },
      { title: '工具调用', text: args.tools || '暂无工具调用。', limit: 3000 },
      ...(args.details || []),
    ],
    footer: args.schema === '2.0'
      ? [{ tag: 'div', text: { tag: 'plain_text', content: footer, text_size: 'notation', text_color: 'grey' } }]
      : [{ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] }],
  });
}
