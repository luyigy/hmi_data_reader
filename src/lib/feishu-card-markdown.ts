/** Feishu card markdown cannot upload local images, including examples inside code spans. */
export function safeCardMarkdown(text: string) {
  return text.replace(/!\[([^\]]*)\]\(([^)\n]*)\)/g, (_match, label: string, target: string) =>
    /^https?:\/\//i.test(target) ? `[${label || '图片'}](${target})` : `${label || '图片'}〔附件另行展示〕`);
}

export function safeFeishuCard(card: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'content' && typeof child === 'string' ? safeCardMarkdown(child) : visit(child)]));
  };
  return Object.fromEntries(Object.entries(card).map(([key, value]) => [key, visit(value)]));
}

export function replyImagePaths(text: string) {
  const plain = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  return Array.from(new Set(Array.from(plain.matchAll(/!\[[^\]]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g), match => match[1] || match[2])
    .filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target))));
}
