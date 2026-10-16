const codes = { configure: 'c', suggest: 's', approve: 'a', page: 'p' } as const;
export type GraphFormDecision = keyof typeof codes;

export function graphFormButtonName(id: string, hash: string, decision: GraphFormDecision, page: number) {
  return `tg:${codes[decision]}:${id}:${hash}:${page}`;
}

/** Card 2.0 form buttons submit their name/form_value, without callback behaviors. */
export function graphFormAction(name: string | undefined): Record<string, unknown> | null {
  const graph = name?.match(/^tg:([csap]):([a-z0-9]+):([a-f0-9]{64}):(\d+)$/);
  if (graph) return { cmd: 'task-graph-launch', proposalId: graph[2], hash: graph[3],
    decision: Object.entries(codes).find(([, code]) => code === graph[1])![0], page: Number(graph[4]) };
  const picker = name?.match(/^tgs:([a-z0-9]+):([a-f0-9]{40})$/);
  return picker ? { cmd: 'graph-spec-picker', roomId: picker[1], commit: picker[2] } : null;
}
