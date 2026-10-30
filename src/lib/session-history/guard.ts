import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HarnessAdapter } from '../harness/types';
import { normalizeNativeId } from './types';

export const historyStateRoot = () => process.env.AP_SESSION_HISTORY_STATE_ROOT || path.join(homedir(), '.agent-platform/session-history');
const hash = (harness: string, id: string) => createHash('sha256').update(JSON.stringify([harness, normalizeNativeId(harness, id)])).digest('hex');
export async function withHistoryLock<T>(name: string, exclusive: boolean, action: () => Promise<T>): Promise<T> {
  const root = path.join(historyStateRoot(), 'locks'); await mkdir(root, { recursive: true, mode: 0o700 });
  const child = spawn('flock', [exclusive ? '-x' : '-s', '-w', '5', path.join(root, hash('lock', name)), 'sh', '-c', 'printf "READY\\n"; read release'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY\n')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('会话正在使用或清理，请稍后重试')));
    });
    return await action();
  } finally { child.stdin.on('error', () => {}); child.stdin.end('\n'); await exited; }
}
export async function historyTombstone(harness: string, id: string): Promise<boolean> {
  try { await readFile(path.join(historyStateRoot(), 'deleted', hash(harness, id) + '.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function blockHistorySession(harness: string, id: string, operationId: string) {
  const root = path.join(historyStateRoot(), 'deleted'); await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, hash(harness, id) + '.json'), JSON.stringify({ harness, id, operationId, blockedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
}
export async function assertHistoryAvailable(harness: string, id: string) {
  if (await historyTombstone(harness, id)) throw new Error('原生会话已清理或清理待核对，请新建会话；不能继续旧历史');
}
/** Shared for the entire invocation; cleanup takes the exclusive harness lease across processes. */
export function withHistoryProtection(adapter: HarnessAdapter): HarnessAdapter {
  if (!['codex', 'pi-agent'].includes(adapter.type)) return adapter;
  const run = async (args: Parameters<HarnessAdapter['execute']>[0], id: string | undefined, action: (context: typeof args.context) => ReturnType<HarnessAdapter['execute']>) => {
    if (args.context.executionBackend !== 'platform_local') return action(args.context);
    return withHistoryLock(adapter.type, false, async () => {
      if (id) await assertHistoryAvailable(adapter.type, id);
      return action({ ...args.context, onSessionStarted: async session => {
        await assertHistoryAvailable(adapter.type, session.sessionId);
        await args.context.onSessionStarted?.(session);
      } });
    });
  };
  return { ...adapter,
    execute: args => run(args, undefined, context => adapter.execute({ ...args, context })),
    resume: adapter.resume ? args => run(args, args.sessionId, context => adapter.resume!({ ...args, context })) : undefined,
  };
}
