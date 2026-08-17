/**
 * Agent effective status derivation for Dashboard consumers.
 *
 * Remote gateway agents are synced by `syncGatewayAgents`, which stamps
 * `status: online` + `lastHeartbeat` on every successful sync. When the sync
 * stops (gateway down / RPC failing) the stored status stays online forever,
 * so Dashboard consumers must combine the stored status with heartbeat
 * freshness. Platform local agents have no real heartbeat source yet and keep
 * their stored status semantics; a Dashboard GET must not fake health checks.
 */

/** Auto-heartbeat cadence used by GatewayManager's gateway clients. */
export const REMOTE_AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Offline threshold: 3 heartbeat cycles (90s) without a fresh heartbeat. */
export const REMOTE_AGENT_OFFLINE_THRESHOLD_MS = REMOTE_AGENT_HEARTBEAT_INTERVAL_MS * 3;

export type AgentStatusValue = 'online' | 'offline' | 'busy' | 'error';

const KNOWN_STATUSES: readonly AgentStatusValue[] = ['online', 'offline', 'busy', 'error'];

const normalizeStatus = (status: string | null | undefined): AgentStatusValue =>
  KNOWN_STATUSES.includes(status as AgentStatusValue) ? (status as AgentStatusValue) : 'offline';

const heartbeatAgeMs = (
  lastHeartbeat: Date | string | null | undefined,
  now: Date
): number | null => {
  if (lastHeartbeat === null || lastHeartbeat === undefined) return null;
  const time = lastHeartbeat instanceof Date ? lastHeartbeat.getTime() : Date.parse(lastHeartbeat);
  return Number.isNaN(time) ? null : now.getTime() - time;
};

export interface EffectiveAgentStatusInput {
  /** Derived backend; only gateway agents use heartbeat freshness. */
  backend: string;
  status: string | null | undefined;
  lastHeartbeat: Date | string | null | undefined;
}

/**
 * Effective agent status combining stored status with heartbeat freshness:
 * - platform local agents keep the stored status (no real heartbeat source);
 * - remote gateway agents only stay `online` while their heartbeat is within
 *   REMOTE_AGENT_OFFLINE_THRESHOLD_MS; stale/missing heartbeats read offline.
 */
export function computeEffectiveAgentStatus(
  agent: EffectiveAgentStatusInput,
  now: Date = new Date()
): AgentStatusValue {
  const stored = normalizeStatus(agent.status);
  if (agent.backend !== 'gateway_openclaw') return stored;
  if (stored !== 'online') return stored;
  const age = heartbeatAgeMs(agent.lastHeartbeat, now);
  if (age === null || age >= REMOTE_AGENT_OFFLINE_THRESHOLD_MS) return 'offline';
  return stored;
}
