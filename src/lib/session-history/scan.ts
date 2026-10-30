import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { HistoryFile, HistoryRecord, HistorySource, normalizeNativeId } from './types';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const jsonId = new RegExp(`(${uuid})\\.jsonl$`, 'i');
const dbId = new RegExp(`^(${uuid})\\.db$`, 'i');
export class ScanBudget {
  count = 0;
  constructor(public maxEntries = 50000, public deadline = Date.now() + 15000) {}
  tick() { if (++this.count > this.maxEntries || Date.now() > this.deadline) throw new Error('扫描达到数量或时间上限；本次结果不完整'); }
}
export function defaultSources(): HistorySource[] {
  return [
    { harness: 'codex', home: process.env.CODEX_HOME || path.join(homedir(), '.codex'), label: '本机 Codex' },
    { harness: 'kimi-code', home: process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code'), label: '本机 Kimi Code' },
    { harness: 'pi-agent', home: process.env.PI_AGENT_SESSION_ROOT || path.join(homedir(), '.acpx/pi-agent-sessions'), label: '平台 Pi 会话目录' },
    { harness: 'antigravity', home: path.join(homedir(), '.gemini/antigravity-cli'), label: '本机 Antigravity CLI' },
  ];
}
export async function safeStat(root: string, file: string) {
  if (!path.isAbsolute(root) || !(file === root || file.startsWith(root + path.sep))) throw new Error('路径超出存储范围');
  const info = await lstat(file);
  if (info.isSymbolicLink() || await realpath(file) !== file) throw new Error('符号链接或路径替换，不允许管理');
  if (!info.isDirectory() && !info.isFile()) throw new Error('特殊文件不允许管理');
  return info;
}
async function jsonHead(file: string, whole = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (whole && info.size > 1024 * 1024) throw new Error('会话元信息超过读取上限');
    const buffer = Buffer.alloc(whole ? info.size : 65536);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read.bytesRead).toString();
    return JSON.parse(whole ? text : text.split('\n')[0]);
  } finally { await handle.close(); }
}
function date(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
async function metadata(record: HistoryRecord) {
  if (record.harness === 'antigravity') return;
  if (record.harness === 'kimi-code') {
    const state = await jsonHead(path.join(record.location, 'state.json'), true);
    if (normalizeNativeId('kimi-code', state.id || '') !== record.nativeId) throw new Error('原生身份不匹配');
    record.project = typeof state.cwd === 'string' ? state.cwd : null;
    const updated = date(state.updatedAt);
    if (!Number.isFinite(updated)) throw new Error('缺少原生活动时间');
    record.lastActivity = Math.max(record.lastActivity || 0, updated);
    return;
  }
  for (const file of record.files) {
    const native = await jsonHead(path.join(record.location, file.relative));
    if (record.harness === 'codex') {
      if (native.type !== 'session_meta' || native.payload?.id !== record.nativeId) throw new Error('原生身份不匹配');
      record.project = typeof native.payload.cwd === 'string' ? native.payload.cwd : null;
    } else {
      if (native.type !== 'session' || typeof native.id !== 'string') throw new Error('Pi 原生记录格式不匹配');
      record.project = typeof native.cwd === 'string' ? native.cwd : null;
    }
    const time = date(native.timestamp);
    if (Number.isFinite(time)) record.lastActivity = Math.max(record.lastActivity || 0, time);
  }
}
export async function measureRecord(source: HistorySource, nativeId: string, location: string, names?: string[], budget = new ScanBudget()): Promise<HistoryRecord> {
  const files: HistoryFile[] = [];
  const record: HistoryRecord = { ...source, nativeId, location, key: digest([hostname(), process.getuid?.(), source.harness, source.home, nativeId]),
    project: null, bytes: null, lastActivity: null, files, fingerprint: '', issues: [] };
  try {
    await safeStat(source.home, source.home);
    await safeStat(source.home, location);
    const visit = async (file: string, depth = 0): Promise<void> => {
      budget.tick();
      if (depth > 12) throw new Error('会话目录层级过深');
      const info = await safeStat(source.home, file);
      if (info.isDirectory()) {
        for (const name of await readdir(file)) await visit(path.join(file, name), depth + 1);
      } else {
        files.push({ relative: path.relative(location, file), identity: `${info.dev}:${info.ino}`, bytes: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs });
      }
    };
    if (names) for (const name of names) await visit(path.join(location, name));
    else await visit(location);
    files.sort((a, b) => a.relative.localeCompare(b.relative));
    if (!files.length) throw new Error('没有可识别的原生记录');
    if (source.harness === 'pi-agent' && files.some(file => file.relative.includes(path.sep) || !file.relative.endsWith('.jsonl'))) throw new Error('Pi 目录包含未适配的附属文件');
    record.bytes = files.reduce((total, file) => total + file.bytes, 0);
    record.lastActivity = Math.max(...files.map(file => file.mtime));
    await metadata(record);
    record.fingerprint = digest(files);
  } catch (error) { record.issues.push(error instanceof SyntaxError ? '原生元信息 JSON 无效' : error instanceof Error ? error.message : '读取失败'); }
  return record;
}
export async function scanSource(source: HistorySource, budget: ScanBudget) {
  source = { ...source, home: path.resolve(source.home) };
  await safeStat(source.home, source.home);
  const records: HistoryRecord[] = [];
  if (source.harness === 'codex') {
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) throw new Error('Codex 历史目录层级异常');
      await safeStat(source.home, dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        budget.tick();
        if (entry.isSymbolicLink()) throw new Error('历史目录含符号链接');
        if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
        else if (entry.name.startsWith('rollout-') && jsonId.test(entry.name)) {
          records.push(await measureRecord(source, entry.name.match(jsonId)![1], dir, [entry.name], budget));
        }
      }
    };
    for (const child of ['sessions', 'archived_sessions']) {
      try { await visit(path.join(source.home, child), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } else if (source.harness === 'kimi-code') {
    const root = path.join(source.home, 'sessions'); await safeStat(source.home, root);
    for (const wd of await readdir(root, { withFileTypes: true })) {
      budget.tick(); if (!wd.isDirectory()) continue;
      const directory = path.join(root, wd.name); await safeStat(source.home, directory);
      for (const session of await readdir(directory, { withFileTypes: true })) {
        budget.tick(); if (!session.isDirectory() || !session.name.startsWith('session_')) continue;
        records.push(await measureRecord(source, normalizeNativeId(source.harness, session.name), path.join(directory, session.name), undefined, budget));
      }
    }
  } else if (source.harness === 'pi-agent') {
    for (const entry of await readdir(source.home, { withFileTypes: true })) {
      budget.tick(); if (!entry.isDirectory() || entry.name.startsWith('.ap-delete-')) continue;
      const directory = path.join(source.home, entry.name);
      records.push(await measureRecord(source, directory, directory, undefined, budget));
    }
  } else {
    const root = path.join(source.home, 'conversations'); await safeStat(source.home, root);
    for (const name of await readdir(root)) {
      budget.tick(); const id = name.match(dbId)?.[1]; if (!id) continue;
      const names = [name];
      for (const suffix of ['-wal', '-shm']) {
        try { await lstat(path.join(root, name + suffix)); names.push(name + suffix); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      records.push(await measureRecord(source, id, root, names, budget));
    }
  }
  return records;
}
