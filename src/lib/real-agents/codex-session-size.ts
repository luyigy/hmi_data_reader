import { withNativeSessionSize } from './native-session-size';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionSizeSample } from '../session-size';

export async function findCodexSessionFile(sessionId: string, codexHome?: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  try {
    const root = await realpath(path.join(codexHome || process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'), 'sessions'));
    const matches = (await readdir(root, { recursive: true })).filter(name =>
      path.basename(name).startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`));
    if (matches.length !== 1) return null;
    const file = await realpath(path.join(root, matches[0]));
    return file.startsWith(`${root}${path.sep}`) ? { root, file } : null;
  } catch { return null; }
}

/** Only stat + a bounded identity header; never load the growing history to measure it. */
export async function readCodexSessionBytes(location: { root: string; file: string }, sessionId: string) {
  try {
    const file = await realpath(location.file);
    if (!file.startsWith(`${location.root}${path.sep}`)) return null;
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      const header = JSON.parse(first);
      return header.type === 'session_meta' && header.payload?.id === sessionId
        ? { bytes: info.size, identity: `${info.dev}:${info.ino}` } : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

export function withCodexSessionSize<T>(scope: {
  executionId?: string; sessionId?: string; codexHome?: string; ephemeral?: boolean;
  onSample?: (sample: SessionSizeSample) => Promise<void> | void;
}, run: (onSession: (id: string) => Promise<void>) => Promise<T>): Promise<T> {
  let currentId: string | undefined;
  let location: Awaited<ReturnType<typeof findCodexSessionFile>> = null;
  return withNativeSessionSize({ ...scope, read: async id => {
    if (currentId !== id) { currentId = id; location = null; }
    location ??= await findCodexSessionFile(id, scope.codexHome);
    return location ? readCodexSessionBytes(location, id) : null;
  } }, run);
}
