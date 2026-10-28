import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { NativeSessionBytes } from './native-session-size';

const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
const uuid = (id: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const within = (root: string, file: string) => file.startsWith(root + path.sep);

async function measure(root: string, names: string[], jsonHeader = false): Promise<NativeSessionBytes | null> {
  const rootStat = await stat(root);
  const files: NonNullable<NativeSessionBytes['files']> = {};
  for (const name of names) {
    if ((await lstat(name)).isSymbolicLink()) return null;
    const file = await realpath(name);
    if (!within(root, file)) return null;
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      if (jsonHeader) {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const header = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
        if (header.type !== 'session' || typeof header.id !== 'string' || !safeId(header.id)) return null;
      }
      files[path.relative(root, file)] = { bytes: info.size, identity: `${info.dev}:${info.ino}` };
    } finally { await handle.close(); }
  }
  return { bytes: Object.values(files).reduce((sum, item) => sum + item.bytes, 0),
    identity: `${rootStat.dev}:${rootStat.ino}`, files };
}

/** Kimi's native session directory: main/subagent wire and context records, not the entire agent home. */
export async function readKimiSessionBytes(id: string, home = process.env.KIMI_CODE_HOME?.trim() || path.join(homedir(), '.kimi-code')) {
  if (!safeId(id)) return null;
  try {
    const root = await realpath(path.join(home, 'sessions'));
    const matches: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, id.startsWith('session_') ? id : `session_${id}`);
      try { if ((await lstat(candidate)).isDirectory()) matches.push(await realpath(candidate)); } catch {}
    }
    if (matches.length !== 1 || !within(root, matches[0])) return null;
    const names: string[] = [];
    let entries = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) throw new Error('Session directory too deep');
      const children = await readdir(dir, { withFileTypes: true });
      entries += children.length;
      if (entries > 10_000) throw new Error('Session entry limit');
      for (const item of children) {
        if (item.isSymbolicLink()) throw new Error('Session symlink');
        if (item.isDirectory()) await visit(path.join(dir, item.name), depth + 1);
        else if (item.isFile()) names.push(path.join(dir, item.name));
        if (names.length > 10_000) throw new Error('Session file limit');
      }
    };
    await visit(matches[0], 0);
    return names.length ? await measure(matches[0], names) : null;
  } catch { return null; }
}

/** Pi continuation identity is the dedicated --session-dir; only native JSONL histories count. */
export async function readPiSessionBytes(dir: string, base = process.env.PI_AGENT_SESSION_ROOT?.trim() || path.join(homedir(), '.acpx/pi-agent-sessions')) {
  try {
    if (!path.isAbsolute(dir)) return null;
    const root = await realpath(base), session = await realpath(dir);
    if (!within(root, session) || (await lstat(dir)).isSymbolicLink()) return null;
    const names = (await readdir(session)).filter(name => name.endsWith('.jsonl'));
    if (names.length > 10_000) return null;
    return await measure(session, names.map(name => path.join(session, name)), true);
  } catch { return null; }
}

/** Antigravity CLI persists each conversation in SQLite; WAL bytes are history, SHM/brain artifacts are not. */
export async function readAntigravitySessionBytes(id: string, home = path.join(homedir(), '.gemini/antigravity-cli')) {
  if (!uuid(id)) return null;
  try {
    const root = await realpath(path.join(home, 'conversations'));
    const names = [path.join(root, `${id}.db`)];
    if ((await lstat(names[0])).isSymbolicLink() || !within(root, await realpath(names[0]))) return null;
    const handle = await open(names[0], 'r');
    try {
      const header = Buffer.alloc(16); await handle.read(header, 0, 16, 0);
      if (header.toString() !== 'SQLite format 3\0') return null;
    } finally { await handle.close(); }
    try { await lstat(names[0] + '-wal'); names.push(names[0] + '-wal'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return await measure(root, names);
  } catch { return null; }
}
