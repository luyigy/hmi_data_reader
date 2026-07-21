export function extractFeishuPostText(value: unknown): string {
  const extract = (nodeValue: unknown): string[] => {
    if (Array.isArray(nodeValue)) return nodeValue.flatMap(extract);
    if (!nodeValue || typeof nodeValue !== 'object') return [];

    const node = nodeValue as Record<string, unknown>;
    if (node.tag === 'at' && typeof node.user_name === 'string') return [`@${node.user_name}`];
    if (typeof node.text === 'string') return [node.text];

    return [
      ...(typeof node.title === 'string' ? [node.title] : []),
      ...Object.entries(node)
        .filter(([key]) => key !== 'title')
        .flatMap(([, child]) => extract(child)),
    ];
  };

  return extract(value).map((part) => part.trim()).filter(Boolean).join('\n');
}
