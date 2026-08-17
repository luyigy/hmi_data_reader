/**
 * Live Room room-level execution timeout configuration.
 *
 * Semantics (PLAN 444 S01):
 * - `executionTimeoutMs = null` keeps the existing backend defaults
 *   (remote SSH / remote runner: 10 minutes; Platform Local codex/claude/kimi-code: unlimited;
 *   other local harnesses: 24h runner-harness default).
 * - An explicit value is stored in milliseconds, restricted to 1-1440 whole minutes.
 * - Wall-clock execution timeouts must never be treated as invalid continuation
 *   (no fresh-session retry), and delivery reapers must use the room's effective
 *   timeout plus a grace window instead of the old hardcoded 10m30s / 12m thresholds.
 */

export const DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES = 1;
export const MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES = 1440;

/** Grace added to the effective timeout before a remote (SSH/runner) delivery is reclaimed. */
export const REMOTE_DELIVERY_STALE_GRACE_MS = 30 * 1000;
/** Grace added to the effective timeout before a running delivery is reclaimed by the watchdog. */
export const RUNNING_DELIVERY_STALE_GRACE_MS = 2 * 60 * 1000;

const INHERIT_TIMEOUT_ALIASES = new Set(['inherit', 'default', 'reset', 'clear', 'off']);

export type ParsedLiveRoomExecutionTimeout =
  | { kind: 'inherit' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'invalid' };

/**
 * Parse a user-supplied timeout (minutes). Rejects NaN, negatives, decimals and
 * out-of-range values; empty input or an inherit alias keeps backend defaults.
 */
export const parseLiveRoomExecutionTimeoutInput = (
  value: string | number | null | undefined
): ParsedLiveRoomExecutionTimeout => {
  if (value === null || value === undefined) {
    return { kind: 'inherit' };
  }
  const normalized = (typeof value === 'number' ? String(value) : value).trim();
  if (!normalized || INHERIT_TIMEOUT_ALIASES.has(normalized.toLowerCase())) {
    return { kind: 'inherit' };
  }
  // Only whole, non-negative digits pass; this rejects NaN, "-3", "0.5", "1e3", "30m".
  if (!/^\d+$/.test(normalized)) {
    return { kind: 'invalid' };
  }
  const minutes = Number(normalized);
  if (
    !Number.isSafeInteger(minutes)
    || minutes < MIN_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES
    || minutes > MAX_LIVE_ROOM_EXECUTION_TIMEOUT_MINUTES
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'minutes', minutes };
};

export const liveRoomTimeoutMinutesToMs = (minutes: number) => minutes * 60 * 1000;

export const liveRoomTimeoutMsToMinutes = (ms: number) => Math.round(ms / 60000);

/** Normalize a stored `executionTimeoutMs` to a positive integer, or null when unset. */
export const resolveLiveRoomExecutionTimeoutMs = (
  executionTimeoutMs?: number | null
): number | null => {
  if (typeof executionTimeoutMs !== 'number' || !Number.isFinite(executionTimeoutMs)) {
    return null;
  }
  const rounded = Math.round(executionTimeoutMs);
  return rounded > 0 ? rounded : null;
};

/**
 * Resolve the watchdog config for a live-room attempt.
 * - Explicit room timeout → `{ maxRuntimeMs }` for every backend (remote SSH and
 *   remote runner share this single result).
 * - No explicit timeout → keep today's behavior: Platform Local codex/claude/kimi-code
 *   run unlimited (`maxRuntimeMs: null`); everything else falls back to the
 *   runner-harness local/remote defaults (`undefined`).
 */
export const resolveLiveRoomExecutionWatchdogConfig = ({
  executionTimeoutMs,
  executionBackend,
  harnessType,
}: {
  executionTimeoutMs?: number | null;
  executionBackend?: string | null;
  harnessType?: string | null;
}): { maxRuntimeMs: number | null } | undefined => {
  const explicitMs = resolveLiveRoomExecutionTimeoutMs(executionTimeoutMs);
  if (explicitMs !== null) {
    return { maxRuntimeMs: explicitMs };
  }
  return executionBackend === 'platform_local'
    && ['codex', 'claude', 'kimi-code'].includes(harnessType ?? '')
    ? { maxRuntimeMs: null }
    : undefined;
};

/** Effective timeout for a room: explicit value, else the 10-minute remote default. */
export const resolveLiveRoomEffectiveTimeoutMs = (executionTimeoutMs?: number | null): number =>
  resolveLiveRoomExecutionTimeoutMs(executionTimeoutMs) ?? DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS;

/** Threshold used by the remote delivery reaper (effective timeout + 30s grace). */
export const resolveRemoteDeliveryStaleAfterMs = (executionTimeoutMs?: number | null): number =>
  resolveLiveRoomEffectiveTimeoutMs(executionTimeoutMs) + REMOTE_DELIVERY_STALE_GRACE_MS;

/** Threshold used by the running-delivery watchdog (effective timeout + 2min grace). */
export const resolveRunningDeliveryStaleAfterMs = (executionTimeoutMs?: number | null): number =>
  resolveLiveRoomEffectiveTimeoutMs(executionTimeoutMs) + RUNNING_DELIVERY_STALE_GRACE_MS;
