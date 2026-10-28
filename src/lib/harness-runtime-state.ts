import { randomUUID } from 'node:crypto';
import type { HarnessRuntimeState } from './harness/types';
import { parseJsonObject } from './acpx/runner-metadata';
import { prisma } from './prisma';
import { normalizeSessionSize } from './session-size';

interface RuntimeExecution {
  id: string;
  participantId: string;
  startedAt: number;
  completedAt?: number;
}
const MAX_AGE_MS = 15 * 60 * 1000;
const text = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
const time = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;

// Whitelist fields: raw logs and protocol payloads must never enter metadata.
function normalizeRuntimeState(value: unknown): HarnessRuntimeState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as HarnessRuntimeState;
  if (!text(state.executionId) || !text(state.sessionId) || !text(state.source)
    || !['runner', 'provider'].includes(state.evidence) || !time(state.observedAt)
    || (state.turnId !== undefined && !text(state.turnId))
    || (state.provider !== undefined && !text(state.provider))
    || (state.model !== undefined && (!text(state.model) || !['model_id', 'alias'].includes(state.modelKind!)))) return null;
  const reasoning = state.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return null;
  let native: HarnessRuntimeState['reasoning'];
  switch (reasoning.kind) {
    case 'level':
      if (!text(reasoning.value)) return null;
      native = { kind: 'level', value: reasoning.value }; break;
    case 'toggle':
      if (typeof reasoning.enabled !== 'boolean') return null;
      native = { kind: 'toggle', enabled: reasoning.enabled }; break;
    case 'unknown': case 'not_applicable': native = { kind: reasoning.kind }; break;
    default: return null;
  }
  return {
    executionId: state.executionId, sessionId: state.sessionId,
    ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
    ...(state.model === undefined ? {} : { model: state.model, modelKind: state.modelKind }),
    ...(state.provider === undefined ? {} : { provider: state.provider }),
    reasoning: native, source: state.source, evidence: state.evidence, observedAt: state.observedAt,
  };
}

export function readHarnessRuntimeState(metadata: string | null | undefined, options: {
  participantId?: string;
  startedAt?: number;
  now?: number;
} = {}): HarnessRuntimeState | null {
  const data = parseJsonObject(metadata);
  const execution = data.runtimeExecution as RuntimeExecution | undefined;
  const state = normalizeRuntimeState(data.runtimeState);
  const now = options.now ?? Date.now();
  if (!state || !execution || !options.participantId || execution.participantId !== options.participantId
    || !text(execution.id) || state.executionId !== execution.id
    || !time(execution.startedAt) || !time(execution.completedAt)
    || execution.completedAt < execution.startedAt || execution.completedAt > now + 60_000
    || state.observedAt < execution.startedAt || state.observedAt > execution.completedAt
    || state.sessionId !== data.lastSessionId) return null;
  // A final reply belongs to an execution, even if that execution lasted hours.
  // Panels expire by completion time; rereading evidence never refreshes its age.
  if (options.startedAt !== undefined
    ? !time(options.startedAt) || execution.startedAt < options.startedAt
    : now - execution.completedAt > MAX_AGE_MS) return null;
  return state;
}

async function updateRuntimeMetadata(participantId: string, patch: (
  metadata: Record<string, unknown>
) => Record<string, unknown> | null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.taskRunParticipant.findUnique({
      where: { id: participantId }, select: { controlMetadata: true },
    });
    if (!row) return;
    const changes = patch(parseJsonObject(row.controlMetadata));
    if (!changes) return;
    const updated = await prisma.taskRunParticipant.updateMany({
      where: { id: participantId, controlMetadata: row.controlMetadata },
      data: { controlMetadata: JSON.stringify({ ...parseJsonObject(row.controlMetadata), ...changes }) },
    });
    if (updated.count) return;
  }
  throw new Error('Runtime telemetry metadata contention');
}

export async function beginHarnessRuntimeExecution(participantId: string): Promise<RuntimeExecution> {
  const execution = { id: randomUUID(), participantId, startedAt: Date.now() };
  try {
    await updateRuntimeMetadata(participantId, () => ({ runtimeExecution: execution, runtimeState: null, sessionSize: null }));
  } catch {
    console.warn('Runtime telemetry: could not initialize execution', participantId);
  }
  return execution;
}

export async function persistHarnessRuntimeState(execution: RuntimeExecution, value: unknown) {
  if (value === undefined) return;
  const state = normalizeRuntimeState(value);
  const completedAt = Date.now();
  if (!state || state.executionId !== execution.id || state.observedAt < execution.startedAt
    || state.observedAt > completedAt) {
    console.warn('Runtime telemetry: rejected invalid or unbound evidence', execution.participantId);
    return;
  }
  try {
    await updateRuntimeMetadata(execution.participantId, data => {
      const current = data.runtimeExecution as RuntimeExecution | undefined;
      if (current?.id !== execution.id || current.completedAt !== undefined || data.lastSessionId !== state.sessionId) {
        console.warn('Runtime telemetry: rejected superseded execution or session', execution.participantId);
        return null;
      }
      return { runtimeExecution: { ...execution, completedAt }, runtimeState: state };
    });
  } catch {
    console.warn('Runtime telemetry: could not persist evidence', execution.participantId);
  }
}

export async function persistSessionSize(execution: RuntimeExecution, value: unknown, remoteBinding?: { sessionKind: 'pi_session_dir' }) {
  const sample = normalizeSessionSize(value);
  if (!sample || sample.executionId !== execution.id || sample.observedAt < execution.startedAt || sample.observedAt > Date.now()) return;
  let accepted = false;
  await updateRuntimeMetadata(execution.participantId, data => {
    const current = data.runtimeExecution as RuntimeExecution | undefined;
    const previous = normalizeSessionSize(data.sessionSize);
    accepted = current?.id === execution.id && current.completedAt === undefined && (!!remoteBinding || data.lastSessionId === sample.sessionId)
      && (!previous || previous.observedAt <= sample.observedAt);
    return accepted ? { sessionSize: sample, ...(remoteBinding ? { lastSessionId: sample.sessionId, lastSessionKind: remoteBinding.sessionKind } : {}) } : null;
  });
  return accepted;
}

export function formatHarnessRuntimeState(state: HarnessRuntimeState | null): string {
  const reasoning = state?.reasoning;
  const label = reasoning?.kind === 'level' ? `思考档位：${reasoning.value}`
    : reasoning?.kind === 'toggle' ? `思考开关：${reasoning.enabled ? '开启' : '关闭'}`
    : reasoning?.kind === 'not_applicable' ? '思考状态：不适用（运行器明确报告）'
    : '思考状态：实际值未确认';
  return `模型：${state?.model || '实际值未确认'}${state?.modelKind === 'alias' ? '（别名）' : ''}`
    + `${state?.provider ? ` · provider：${state.provider}` : ''} · ${label}`
    + (state ? ` · ${state.evidence === 'provider' ? '供应商回执' : '运行器报告'} / ${state.source}`
      + ` · 最近观测：${new Date(state.observedAt).toISOString()}` : '');
}
