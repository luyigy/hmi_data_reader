import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { HarnessRuntimeState, NormalizedContextUsage } from '@/lib/harness/types';

interface EvidenceScope {
  executionId?: string;
  threadId?: string | null;
  turnId?: string;
  startedAt: number;
  completedAt: number;
  codexHome?: string;
  ephemeral?: boolean;
}
const text = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);

// Only runner records from this invocation qualify; thread config is not turn evidence.
export async function parseCodexTelemetry(
  lines: AsyncIterable<string> | Iterable<string>, scope: EvidenceScope,
): Promise<{ runtimeState?: HarnessRuntimeState; contextUsage?: NormalizedContextUsage } | undefined> {
  if (!text(scope.executionId) || !text(scope.threadId)) return;
  let sessionVerified = false;
  const starts = new Map<string, number>();
  const completed = new Set<string>();
  const states = new Map<string, HarnessRuntimeState>();
  const usages = new Map<string, NormalizedContextUsage>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (!record || typeof record !== 'object') return;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (record.type === 'session_meta') {
      if (payload.id !== scope.threadId || sessionVerified) return;
      sessionVerified = true;
      continue;
    }
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (!sessionVerified || !Number.isFinite(at) || at < scope.startedAt || at > scope.completedAt) continue;
    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const active = Array.from(starts.keys()).filter(id => !completed.has(id));
      const turn = text(payload.turn_id) ? payload.turn_id : active.length === 1 ? active[0] : undefined;
      const info = payload.info, last = info?.last_token_usage;
      const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (turn && active.includes(turn) && valid(last?.input_tokens) && valid(last?.output_tokens)
        && valid(info.model_context_window) && info.model_context_window > 0
        && at >= (usages.get(turn)?.collectedAt ?? 0)) {
        usages.set(turn, { usedTokens: last.input_tokens, outputTokens: last.output_tokens,
          contextWindow: info.model_context_window, sessionId: scope.threadId,
          metricKind: 'turn_input', confidence: 'measured_exact', collectedAt: at });
      }
      continue;
    }
    if (!text(payload.turn_id)) continue;
    const turn = payload.turn_id;
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      // Repeated/overlapping turns cannot be safely associated with exec's ID-less JSON output.
      if (starts.has(turn)) return;
      starts.set(turn, at);
    } else if (record.type === 'event_msg' && payload.type === 'task_complete' && starts.has(turn)) {
      completed.add(turn);
    } else if (record.type === 'turn_context' && starts.has(turn) && !completed.has(turn)
      && at >= starts.get(turn)! && at >= (states.get(turn)?.observedAt ?? 0)) {
      // Replace the whole observation: a later missing field must not inherit an old model/effort.
      states.set(turn, {
        executionId: scope.executionId, sessionId: scope.threadId, turnId: turn,
        ...(text(payload.model) ? { model: payload.model, modelKind: 'model_id' as const } : {}),
        reasoning: text(payload.effort) ? { kind: 'level', value: payload.effort } : { kind: 'unknown' },
        source: 'codex_rollout.turn_context', evidence: 'runner', observedAt: at,
      });
    }
  }
  const turn = scope.turnId || (starts.size === 1 ? starts.keys().next().value : undefined);
  if (!turn || (!scope.turnId && !completed.has(turn))) return;
  return { runtimeState: states.get(turn), contextUsage: usages.get(turn) };
}

export async function parseCodexRuntimeState(lines: AsyncIterable<string> | Iterable<string>, scope: EvidenceScope) {
  return (await parseCodexTelemetry(lines, scope))?.runtimeState;
}

export async function collectCodexTelemetry(scope: EvidenceScope): Promise<Awaited<ReturnType<typeof parseCodexTelemetry>>> {
  if (!scope.executionId || !scope.threadId || scope.ephemeral) return;
  // The native ID is also used as a filename selector, never accept a path/glob from it.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.threadId)) return;
  try {
    const root = await realpath(path.join(scope.codexHome || process.env.CODEX_HOME?.trim()
      || path.join(homedir(), '.codex'), 'sessions'));
    // ponytail: list this CODEX_HOME's session filenames; add an index if room archives get large.
    const matches = (await readdir(root, { recursive: true })).filter(name =>
      path.basename(name).startsWith('rollout-') && name.endsWith(`-${scope.threadId}.jsonl`));
    if (matches.length !== 1) {
      console.warn('Codex runtime telemetry: missing or ambiguous rollout');
      return;
    }
    const file = await realpath(path.join(root, matches[0]));
    if (!file.startsWith(`${root}${path.sep}`)) return;
    const info = await stat(file);
    if (!info.isFile()) return;
    // Read a bounded tail, plus the original session identity. Never guess a turn cut off by the bound.
    const start = Math.max(0, info.size - 64 * 1024 * 1024);
    let header: string | undefined;
    if (start) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytesRead).toString('utf8');
        if (!first.includes('\n')) return;
        header = first.slice(0, first.indexOf('\n'));
        const meta = JSON.parse(header);
        if (meta.type !== 'session_meta' || meta.payload?.id !== scope.threadId) return;
      } finally { await handle.close(); }
    }
    const input = createReadStream(file, { start, end: info.size - 1, encoding: 'utf8', signal: AbortSignal.timeout(2_000) });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      const records = async function* () {
        if (header !== undefined) yield header;
        let partial = start > 0;
        for await (const line of lines) {
          if (partial) { partial = false; continue; }
          yield line;
        }
      };
      const state = await parseCodexTelemetry(records(), scope);
      if (!state) console.warn('Codex runtime telemetry: no current turn evidence');
      return state;
    } finally { lines.close(); input.destroy(); }
  } catch {
    console.warn('Codex runtime telemetry: rollout unavailable');
    return;
  }
}

export async function collectCodexRuntimeState(scope: EvidenceScope) {
  return (await collectCodexTelemetry(scope))?.runtimeState;
}
