import { Resvg } from '@resvg/resvg-js';
import type { GraphDefinition } from './domain';

export function layoutGraph(graph: GraphDefinition) {
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const rank = (key: string): number => {
    const existing = ranks.get(key);
    if (existing !== undefined) return existing;
    const node = byKey.get(key);
    if (!node || visiting.has(key)) throw new Error('Cannot draw an invalid task graph');
    visiting.add(key);
    const value = node.dependsOn.length ? Math.max(...node.dependsOn.map(rank)) + 1 : 0;
    visiting.delete(key);
    ranks.set(key, value);
    return value;
  };
  graph.nodes.forEach((node) => rank(node.key));
  const levels = Array.from({ length: Math.max(...Array.from(ranks.values())) + 1 }, (_, level) =>
    graph.nodes.filter((node) => ranks.get(node.key) === level));
  const width = Math.max(600, Math.max(...levels.map((row) => row.length)) * 272 + 80);
  const height = levels.length * 122 + 100;
  const nodes = levels.flatMap((row, level) => row.map((node, index) => ({ ...node, rank: level,
    x: (width - row.length * 272 + 24) / 2 + index * 272, y: 66 + level * 122, width: 248, height: 82 })));
  return { width, height, nodes, edges: nodes.flatMap((node) => node.dependsOn.map((source) => ({ source, target: node.key }))) };
}

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] || character);
export function graphSvg(graph: GraphDefinition) {
  const layout = layoutGraph(graph);
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  const edges = layout.edges.map((edge, index) => {
    const source = byKey.get(edge.source)!, target = byKey.get(edge.target)!;
    const sx = source.x + source.width / 2, sy = source.y + source.height;
    const tx = target.x + target.width / 2, ty = target.y - 6;
    const middle = sy + (target.y - sy) / 2;
    const route = target.rank - source.rank > 1
      ? `M${sx},${sy} V${sy + 16} H${layout.width - 16 - index % 3 * 8} V${ty - 18} H${tx} V${ty}`
      : `M${sx},${sy} V${middle} H${tx} V${ty}`;
    return `<path d="${route}" fill="none" stroke="#6b7d98" stroke-width="2" marker-end="url(#arrow)"/>`;
  }).join('');
  const nodes = layout.nodes.map((node) => {
    const words = Array.from(node.goal);
    const lines = [words.slice(0, 16).join(''), words.slice(16, 32).join('') + (words.length > 32 ? '…' : '')].filter(Boolean);
    return `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="#f5f8ff" stroke="#4166a8" stroke-width="1.5"/>
      <text x="${node.x + 16}" y="${node.y + 24}" font-size="16" font-weight="700" fill="#254c8c">${escape(node.key)}</text>
      ${lines.map((line, i) => `<text x="${node.x + 16}" y="${node.y + 47 + i * 18}" font-size="13" fill="#28384f">${escape(line)}</text>`).join('')}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
    <rect width="100%" height="100%" fill="white"/><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#6b7d98" stroke-width="1.5"/></marker></defs>
    <g font-family="Noto Sans CJK SC, sans-serif"><text x="24" y="28" font-size="19" font-weight="700" fill="#25334d">交付路线 · ${graph.nodes.length} 个 Slice</text>
    <text x="24" y="49" font-size="12" fill="#63748f">箭头表示依赖；同层分支可在前置满足后并行</text>${edges}${nodes}</g></svg>`;
}

export function renderGraphPng(graph: GraphDefinition) {
  const layout = layoutGraph(graph);
  return new Resvg(graphSvg(graph), { fitTo: { mode: 'width', value: Math.min(1500, layout.width * 2) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' } }).render().asPng();
}
