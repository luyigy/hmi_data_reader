/** Native history bytes on disk, independent of tokens and context compaction. */
export interface SessionSizeSample {
  executionId: string;
  sessionId: string;
  totalBytes: number;
  deltaBytes?: number;
  observedAt: number;
}

const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function normalizeSessionSize(value: unknown): SessionSizeSample | null {
  if (!value || typeof value !== 'object') return null;
  const sample = value as SessionSizeSample;
  if (typeof sample.executionId !== 'string' || !sample.executionId || typeof sample.sessionId !== 'string' || !sample.sessionId
    || !validNumber(sample.totalBytes) || !validNumber(sample.observedAt)
    || (sample.deltaBytes !== undefined && (!validNumber(sample.deltaBytes) || sample.deltaBytes > sample.totalBytes))) return null;
  return { executionId: sample.executionId, sessionId: sample.sessionId, totalBytes: sample.totalBytes,
    ...(sample.deltaBytes === undefined ? {} : { deltaBytes: sample.deltaBytes }), observedAt: sample.observedAt };
}

export function readSessionSize(metadata: string | null | undefined, scope: { participantId?: string; startedAt: number; now?: number }) {
  try {
    const data = JSON.parse(metadata || '{}');
    const sample = normalizeSessionSize(data.sessionSize);
    const execution = data.runtimeExecution;
    if (!sample || !scope.participantId || execution?.participantId !== scope.participantId
      || sample.executionId !== execution.id || sample.sessionId !== data.lastSessionId
      || !validNumber(execution.startedAt) || execution.startedAt < scope.startedAt
      || sample.observedAt < execution.startedAt || sample.observedAt > (scope.now ?? Date.now()) + 60_000) return null;
    return sample;
  } catch { return null; }
}

export function sessionSizeThresholds(env: Record<string, string | undefined> = process.env) {
  const number = (value: string | undefined, fallback: number) => {
    const parsed = value?.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : fallback;
  };
  const warnMiB = number(env.AP_SESSION_SIZE_WARN_MIB, 10);
  const strongMiB = number(env.AP_SESSION_SIZE_STRONG_MIB, 20);
  return strongMiB > warnMiB ? { warnMiB, strongMiB } : { warnMiB: 10, strongMiB: 20 };
}

export function formatSessionSize(sample: SessionSizeSample | null | undefined) {
  if (!sample) return ['会话记录大小：未采集（当前仅支持本机 Codex 原生记录）'];
  const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(2);
  const { warnMiB, strongMiB } = sessionSizeThresholds();
  const size = sample.totalBytes / 1024 ** 2;
  const warning = size >= strongMiB
    ? `⚠️ 会话记录已达 ${mib(sample.totalBytes)} MiB（强提醒阈值 ${strongMiB} MiB），请先保存交接，再重置当前 Agent 会话。`
    : size >= warnMiB
    ? `⚠️ 会话记录已超过提醒阈值 ${warnMiB} MiB，建议保存交接并重置当前 Agent 会话。` : null;
  return [
    `会话记录：${mib(sample.totalBytes)} MiB · 本轮新增：${sample.deltaBytes === undefined ? '未知' : `+${mib(sample.deltaBytes)} MiB`}（磁盘历史，非上下文占用；采样 ${new Date(sample.observedAt).toISOString()}）`,
    ...(warning ? [warning] : []),
  ];
}
