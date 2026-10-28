/** Active TaskRuns are authoritative; the Session pointer is only a singleton projection. */
export function selectActiveTaskRun<T extends { id: string; status: string }>(runs: T[], selectedRunId?: string | null) {
  const active = runs.filter(run => ['pending', 'running', 'waiting_for_input'].includes(run.status));
  return {
    hasActiveRuns: active.length > 0,
    controlRun: active.find(run => run.id === selectedRunId) ?? (active.length === 1 ? active[0] : null),
  };
}
