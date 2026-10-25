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

export async function withCodexSessionSize<T>(scope: {
  executionId?: string; sessionId?: string; codexHome?: string; ephemeral?: boolean;
  onSample?: (sample: SessionSizeSample) => Promise<void> | void;
}, run: (onSession: (id: string) => Promise<void>) => Promise<T>): Promise<T> {
  if (!scope.executionId || scope.ephemeral || !scope.onSample) return run(async () => {});
  let sessionId = scope.sessionId;
  let location = sessionId ? await findCodexSessionFile(sessionId, scope.codexHome) : null;
  let baseline = sessionId && location ? await readCodexSessionBytes(location, sessionId) : null;
  let fresh = !scope.sessionId;
  let bound = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = Promise.resolve();
  const sample = () => {
    pending = pending.then(async () => {
      if (!bound || !sessionId) return;
      location ??= await findCodexSessionFile(sessionId, scope.codexHome);
      const size = location ? await readCodexSessionBytes(location, sessionId) : null;
      if (!size) return;
      if (fresh && !baseline) baseline = { bytes: 0, identity: size.identity };
      if (baseline && (baseline.identity !== size.identity || size.bytes < baseline.bytes)) {
        baseline = null;
        fresh = false;
      }
      const deltaBytes = baseline && baseline.identity === size.identity && size.bytes >= baseline.bytes
        ? size.bytes - baseline.bytes : undefined;
      await scope.onSample!({ executionId: scope.executionId!, sessionId, totalBytes: size.bytes,
        ...(deltaBytes === undefined ? {} : { deltaBytes }), observedAt: Date.now() });
    }).catch(() => { console.warn('Session size telemetry unavailable'); });
    return pending;
  };
  try {
    return await run(async id => {
      if (sessionId && sessionId !== id) { baseline = null; location = null; fresh = false; }
      sessionId = id;
      bound = true;
      await sample();
      timer ??= setInterval(() => { void sample(); }, 30_000);
      timer.unref();
    });
  } finally {
    clearInterval(timer);
    await sample();
  }
}
