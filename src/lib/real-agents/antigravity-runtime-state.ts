import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { HarnessRuntimeState } from '@/lib/harness/types';

export interface AntigravityEvidenceScope {
  executionId?: string;
  sessionId?: string; // conversation_id
  logFile?: string;
  initModel?: string;
  startedAt: number;
  completedAt: number;
}

export const ANTIGRAVITY_KNOWN_MODELS: Record<string, { id: string; label: string; effort?: string }> = {
  'gemini-3.8-flash-high': { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', effort: 'high' },
  'gemini-3.8-flash-medium': { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', effort: 'medium' },
  'gemini-3.8-flash-low': { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', effort: 'low' },
  'gemini-3.7-flash-high': { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)', effort: 'high' },
  'gemini-3.7-flash-medium': { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)', effort: 'medium' },
  'gemini-3.7-flash-low': { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)', effort: 'low' },
  'gemini-3.6-flash-high': { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', effort: 'high' },
  'gemini-3.6-flash-medium': { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', effort: 'medium' },
  'gemini-3.6-flash-low': { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', effort: 'low' },
  'gemini-3.1-pro-high': { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', effort: 'high' },
  'gemini-3.1-pro-low': { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', effort: 'low' },
  'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', effort: 'thinking' },
  'claude-opus-4-6-thinking': { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', effort: 'thinking' },
  'gpt-oss-120b-medium': { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', effort: 'medium' },
};

const LABEL_TO_MODEL: Record<string, { id: string; effort?: string }> = {};
for (const entry of Object.values(ANTIGRAVITY_KNOWN_MODELS)) {
  LABEL_TO_MODEL[entry.label.toLowerCase()] = { id: entry.id, effort: entry.effort };
}

const text = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);

const parseTimestamp = (line: string, fallbackYear: number): number | undefined => {
  const match = line.match(/^[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})/);
  if (!match) return undefined;
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const hour = parseInt(match[3], 10);
  const min = parseInt(match[4], 10);
  const sec = parseInt(match[5], 10);
  const ms = parseInt(match[6].slice(0, 3), 10);
  const parsed = new Date(fallbackYear, month - 1, day, hour, min, sec, ms).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveEffortFromModelOrLabel = (model?: string, label?: string): string | undefined => {
  if (label) {
    const lower = label.toLowerCase();
    const known = LABEL_TO_MODEL[lower];
    if (known?.effort) return known.effort;
    const match = label.match(/\((High|Medium|Low|Thinking)\)$/i);
    if (match) return match[1].toLowerCase();
  }
  if (model) {
    const known = ANTIGRAVITY_KNOWN_MODELS[model];
    if (known?.effort) return known.effort;
    if (model.endsWith('-high')) return 'high';
    if (model.endsWith('-medium')) return 'medium';
    if (model.endsWith('-low')) return 'low';
    if (model.includes('thinking')) return 'thinking';
  }
  return undefined;
};

export function getAntigravityExecutionLogPath(executionId?: string): string {
  const base = process.env.ANTIGRAVITY_LOG_DIR?.trim()
    || path.join(process.env.HOME || homedir() || '/home/hello', '.gemini', 'antigravity-cli', 'log', 'executions');
  const file = `exec-${executionId || 'default'}.log`;
  return path.join(base, file);
}

export async function parseAntigravityRuntimeState(
  lines: AsyncIterable<string> | Iterable<string>,
  scope: AntigravityEvidenceScope
): Promise<HarnessRuntimeState | undefined> {
  if (!text(scope.executionId) || !text(scope.sessionId)) return undefined;

  let sessionVerified = false;
  let sessionMismatch = false;
  let resolvedModelId: string | undefined;
  let propagatedLabel: string | undefined;
  let printModel: string | undefined;
  let lastObservedAt: number | undefined;

  const fallbackYear = new Date(scope.startedAt).getFullYear();

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const ts = parseTimestamp(line, fallbackYear);
    if (ts !== undefined) {
      // Validate that timestamp is in reasonable range around this execution
      if (ts < scope.startedAt - 10000 || ts > scope.completedAt + 10000) {
        continue;
      }
      lastObservedAt = ts;
    }

    // Verify conversation ID in log entries
    const convMatch = line.match(/(?:Created conversation|resuming conversation|conversation=|conversation\s+)([0-9a-fA-F-]{36})/i)
      || line.match(/Sending user message to conversation\s+([0-9a-fA-F-]{36})/i);
    if (convMatch) {
      const foundId = convMatch[1];
      if (foundId.toLowerCase() === scope.sessionId.toLowerCase()) {
        sessionVerified = true;
      } else {
        sessionMismatch = true;
      }
    }

    const resolverMatch = line.match(/model_resolver\.go:\d+\]\s+Resolving model\s+([a-zA-Z0-9_.-]+)/);
    if (resolverMatch && text(resolverMatch[1])) {
      resolvedModelId = resolverMatch[1];
    }

    const overrideMatch = line.match(/Propagating selected model override to backend:\s+label="([^"]+)"/);
    if (overrideMatch && text(overrideMatch[1])) {
      propagatedLabel = overrideMatch[1];
    }

    const printMatch = line.match(/printmode\.go:\d+\]\s+Print mode: starting \([^)]*model="([^"]+)"/);
    if (printMatch && text(printMatch[1])) {
      printModel = printMatch[1];
    }
  }

  // If a different session was seen in this dedicated log file, reject
  if (sessionMismatch) return undefined;

  // Determine model and modelKind
  let model: string | undefined;
  let modelKind: 'model_id' | 'alias' = 'model_id';

  if (resolvedModelId) {
    model = resolvedModelId;
    modelKind = 'model_id';
  } else if (scope.initModel && text(scope.initModel)) {
    model = scope.initModel;
    modelKind = 'model_id';
  } else if (printModel) {
    model = printModel;
    modelKind = 'model_id';
  } else if (propagatedLabel) {
    const lower = propagatedLabel.toLowerCase();
    const known = LABEL_TO_MODEL[lower];
    if (known) {
      model = known.id;
      modelKind = 'model_id';
    } else {
      model = propagatedLabel;
      modelKind = 'alias';
    }
  }

  if (!model) return undefined;

  // If session verification was not triggered by log lines, but we have initModel or log evidence with no mismatch
  if (!sessionVerified && !resolvedModelId && !propagatedLabel && !printModel && !scope.initModel) {
    return undefined;
  }

  const effort = resolveEffortFromModelOrLabel(model, propagatedLabel);
  const reasoning: HarnessRuntimeState['reasoning'] = effort
    ? { kind: 'level', value: effort }
    : { kind: 'unknown' };

  const observedAt = Math.max(
    scope.startedAt,
    Math.min(scope.completedAt, lastObservedAt ?? scope.startedAt)
  );

  return {
    executionId: scope.executionId,
    sessionId: scope.sessionId,
    turnId: scope.sessionId,
    model,
    modelKind,
    reasoning,
    source: (resolvedModelId || propagatedLabel || printModel) ? 'antigravity_cli.log' : 'antigravity_init',
    evidence: 'runner',
    observedAt,
  };
}

export async function collectAntigravityRuntimeState(
  scope: AntigravityEvidenceScope
): Promise<HarnessRuntimeState | undefined> {
  if (!scope.executionId || !scope.sessionId) return undefined;

  if (scope.logFile) {
    try {
      const info = await stat(scope.logFile);
      if (info.isFile() && info.size > 0 && info.size <= 64 * 1024 * 1024) {
        const input = createReadStream(scope.logFile, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          const state = await parseAntigravityRuntimeState(lines, scope);
          if (state) return state;
        } finally {
          lines.close();
          input.destroy();
        }
      }
    } catch {
      // Log file reading failed or missing; fall back to initModel below
    }
  }

  // Fallback to initModel if available without log file
  if (scope.initModel) {
    return parseAntigravityRuntimeState([], scope);
  }

  return undefined;
}
