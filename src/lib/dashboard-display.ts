/**
 * Pure display helpers shared by Dashboard status components.
 *
 * Kept framework-free so tests can lock the "missing data" wording
 * (never-heartbeated / never-connected / unreported capabilities) without a
 * browser: components render these labels instead of empty areas or
 * `Invalid Date`.
 */

export const NEVER_HEARTBEAT_LABEL = '从未心跳';
export const UNKNOWN_TIME_LABEL = '未知';
export const NEVER_CONNECTED_LABEL = '从未连接';
export const UNREPORTED_CAPABILITIES_LABEL = '未上报';

const formatTimestamp = (value: string): string | null => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toLocaleString('zh-CN');
};

const isMissing = (value: string | null | undefined): value is null | undefined | '' =>
  value === null || value === undefined || value === '';

/** Agent heartbeat display: missing → 从未心跳, unparseable → 未知. */
export function formatAgentHeartbeat(lastHeartbeat: string | null | undefined): string {
  if (isMissing(lastHeartbeat)) return NEVER_HEARTBEAT_LABEL;
  return formatTimestamp(lastHeartbeat) ?? UNKNOWN_TIME_LABEL;
}

/** Remote runner lastSeen display: missing → 从未连接, unparseable → 未知. */
export function formatRemoteNodeLastSeen(lastSeen: string | null | undefined): string {
  if (isMissing(lastSeen)) return NEVER_CONNECTED_LABEL;
  return formatTimestamp(lastSeen) ?? UNKNOWN_TIME_LABEL;
}
