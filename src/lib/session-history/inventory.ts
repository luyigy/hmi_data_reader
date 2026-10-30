import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { defaultSources, scanSource, ScanBudget } from './scan';
import { historyReferences } from './references';
import { historyTombstone } from './guard';
import { HistoryInventory, HistoryRecord, HistoryReference, HistoryRow, HistorySource, RETENTION_MS } from './types';

export function classifyHistory(record: HistoryRecord, refs: HistoryReference[], now: number, ambiguous: boolean): HistoryRow {
  const linked = refs.filter(ref => ref.harness === record.harness && ref.nativeId === record.nativeId);
  const reasons = [...record.issues];
  const lastActivity = Math.max(record.lastActivity || 0, ...linked.map(ref => ref.lastActivity)) || null;
  let state: HistoryRow['state'] = 'eligible';
  if (!lastActivity) reasons.push('无法确定最后活动时间');
  else if (lastActivity > now) reasons.push('活动时间在未来，需核对');
  if (ambiguous) reasons.push('同一原生 ID 对应多处存储，引用归属不明确');
  if (!linked.length) reasons.push('未关联平台，无法确认外部使用状态');
  for (const ref of linked) reasons.push(...ref.reasons);
  if (record.harness === 'kimi-code') reasons.push('只读：原生索引、子会话与排他删除尚未适配');
  if (record.harness === 'antigravity') reasons.push('只读：SQLite、摘要索引与原生进程排他删除尚未适配');
  if (record.issues.length || !lastActivity || lastActivity > now || record.bytes === null) state = 'unknown';
  else if (now - lastActivity <= RETENTION_MS) { state = 'retained'; reasons.unshift('最后活动未超过 30 天'); }
  else if (reasons.length) state = 'protected';
  return { key: record.key, harness: record.harness, nativeId: record.nativeId, home: record.home, location: record.location, label: record.label, project: record.project, bytes: record.bytes,
    lastActivity, state, reasons: Array.from(new Set(reasons)), fileCount: record.files.length,
    references: Array.from(new Map(linked.map(ref => [ref.taskId, { taskId: ref.taskId, taskName: ref.taskName }])).values()) };
}
async function sourcesWithRuntimes(): Promise<HistorySource[]> {
  const sources = defaultSources();
  const root = process.env.TASK_GRAPH_RUNTIME_ROOT || path.join(homedir(), '.agent-platform/task-runtime');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 1000) throw new Error('任务运行目录超过 1000，需缩小范围');
    for (const entry of entries) if (entry.isDirectory()) {
      for (const harness of ['codex', 'kimi-code'] as const) sources.push({ harness, home: path.join(root, entry.name, `.${harness}`), label: `任务运行环境 ${entry.name}` });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return sources;
}
export async function historyInventory(options: { sources?: HistorySource[]; references?: HistoryReference[]; now?: number } = {}) {
  const sampledAt = options.now ?? Date.now();
  const sources = options.sources || await sourcesWithRuntimes();
  const refs = options.references || await historyReferences();
  const budget = new ScanBudget(); const records: HistoryRecord[] = [];
  const statuses: HistoryInventory['sources'] = [];
  let truncated = false;
  for (const source of sources) {
    try {
      const scanned = await scanSource(source, budget); records.push(...scanned);
      statuses.push({ ...source, status: 'ok', count: scanned.length });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) truncated = true;
      statuses.push({ ...source, status: missing ? 'missing' : 'error', count: 0, error: missing ? '目录不存在' : error instanceof Error ? error.message : '读取失败' });
    }
  }
  const idCounts = new Map<string, number>();
  for (const record of records) { const id = record.harness + ':' + record.nativeId; idCounts.set(id, (idCounts.get(id) || 0) + 1); }
  const rows: HistoryRow[] = [];
  for (const record of records) {
    const row = classifyHistory(record, refs, options.now ?? Date.now(), idCounts.get(record.harness + ':' + record.nativeId)! > 1);
    if (truncated) { row.state = 'unknown'; row.reasons.push('扫描不完整，不能确认删除边界'); }
    if (await historyTombstone(record.harness, record.nativeId)) { row.state = 'protected'; row.reasons.push('已有清理操作，需核对回执'); }
    rows.push(row);
  }
  rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || a.key.localeCompare(b.key));
  return { inventory: { sampledAt, rows, sources: statuses, truncated,
    unsupported: ['Claude / Claude Haha', 'DeepSeek', 'Gemini CLI', 'Pi CLI 默认目录（非平台专用目录）', 'SSH / Remote Runner / Gateway', '未登记的自定义运行目录 / Codex 非 JSONL 分页历史'] }, records };
}

let cached: { expires: number; value: Awaited<ReturnType<typeof historyInventory>> } | undefined;
let inFlight: ReturnType<typeof historyInventory> | undefined;
export function invalidateHistoryInventory() { cached = undefined; }
export async function listHistoryInventory() {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (!inFlight) inFlight = historyInventory().then(value => { cached = { value, expires: Date.now() + 30000 }; return value; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
