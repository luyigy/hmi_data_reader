import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessRuntimeState } from '@/lib/harness/types';

type Entry = { type?: string; id?: string; parentId?: string | null; timestamp?: string;
  provider?: string; modelId?: string; thinkingLevel?: string;
  message?: { role?: string; provider?: string; model?: string; stopReason?: string } };
const valid = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);

export function parsePiRuntimeState(lines: string[], scope: {
  executionId: string; sessionDir: string; startedAt: number; completedAt: number; sessionId?: string;
}): HarnessRuntimeState | undefined {
  let header: { id?: string } | undefined;
  const entries = new Map<string, Entry>();
  const current: Entry[] = [];
  for (const line of lines) {
    let entry: Entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'session') { if (header || !valid(entry.id)) return; header = entry; continue; }
    if (!valid(entry.id) || (entry.parentId !== null && !valid(entry.parentId)) || entries.has(entry.id)) return;
    entries.set(entry.id, entry);
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (entry.type === 'message' && entry.message?.role === 'assistant'
      && entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted'
      && Number.isFinite(at) && at >= scope.startedAt && at <= scope.completedAt) current.push(entry);
  }
  if (!header || (scope.sessionId && header.id !== scope.sessionId) || !current.length) return;
  const assistant = current.at(-1)!;
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let cursor: Entry | undefined = assistant;
  while (cursor) {
    if (!cursor.id || seen.has(cursor.id)) return;
    seen.add(cursor.id);
    branch.unshift(cursor);
    cursor = cursor.parentId ? entries.get(cursor.parentId) : undefined;
    if (branch[0].parentId && !cursor) return;
  }
  if (!branch.some(entry => entry.type === 'message' && entry.message?.role === 'user'
    && Date.parse(entry.timestamp || '') >= scope.startedAt)) return;
  const thinking = branch.filter(entry => entry.type === 'thinking_level_change').at(-1)?.thinkingLevel;
  const model = assistant.message?.model;
  const provider = assistant.message?.provider;
  const observedAt = Date.parse(assistant.timestamp!);
  return {
    executionId: scope.executionId, sessionId: scope.sessionDir, turnId: assistant.id!,
    ...(valid(model) ? { model, modelKind: 'model_id' as const } : {}),
    ...(valid(provider) ? { provider } : {}),
    reasoning: valid(thinking) ? { kind: 'level', value: thinking } : { kind: 'unknown' },
    evidence: 'runner', source: 'pi_session.assistant_branch', observedAt,
  };
}

export async function collectPiRuntimeState(scope: {
  executionId?: string; sessionDir: string; sessionFile?: string; sessionId?: string;
  startedAt: number; completedAt: number;
}): Promise<HarnessRuntimeState | undefined> {
  if (!scope.executionId) return;
  try {
    const root = await realpath(scope.sessionDir);
    const names = scope.sessionFile ? [scope.sessionFile] : (await readdir(root))
      .filter(name => name.endsWith('.jsonl')).map(name => path.join(root, name));
    const states: HarnessRuntimeState[] = [];
    for (const name of names) {
      const file = await realpath(name);
      if (path.dirname(file) !== root || !file.endsWith('.jsonl')) continue;
      const info = await stat(file);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
      const state = await parsePiRuntimeState((await readFile(file, 'utf8')).trim().split('\n'), {
        executionId: scope.executionId, sessionDir: scope.sessionDir, startedAt: scope.startedAt,
        completedAt: scope.completedAt, sessionId: scope.sessionId,
      });
      if (state) states.push(state);
    }
    return states.length === 1 ? states[0] : undefined;
  } catch {
    console.warn('Pi runtime telemetry: session record unavailable');
  }
}
