import { spawn } from 'node:child_process';

// Browser checks include disposable dependency setup, a build and a bounded browser suite.
export class GraphCheckTimeoutError extends Error {
  constructor(message: string) { super(message); Object.setPrototypeOf(this, new.target.prototype); }
}
export class GraphCheckCommandError extends Error {
  constructor(message: string) { super(message); Object.setPrototypeOf(this, new.target.prototype); }
}

export const GRAPH_CHECK_TIMEOUT_MS = 10 * 60_000;

/** Bound the whole check and terminate its process group before reporting a timeout. */
export function runGraphCheck(argv: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}, timeoutMs = GRAPH_CHECK_TIMEOUT_MS, displayArgv = argv, abortSignal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: { ...process.env, ...extraEnv }, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-128 * 1024); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-128 * 1024); });
    const abort = () => signalGroup('SIGKILL');
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      force = setTimeout(() => signalGroup('SIGKILL'), 2000);
    }, timeoutMs);
    const clearTimers = () => { abortSignal?.removeEventListener('abort', abort); clearTimeout(timer); if (force) clearTimeout(force); };
    child.once('error', (error) => { clearTimers(); reject(error); });
    child.once('close', (code, signal) => {
      clearTimers();
      if (timedOut) signalGroup('SIGKILL');
      if (abortSignal?.aborted) { reject(abortSignal.reason || new Error('Check cancelled')); return; }
      if (!timedOut && code === 0) { resolve({ stdout, stderr }); return; }
      const reason = timedOut ? `timed out after ${timeoutMs}ms`
        : code !== null ? `exit ${code}` : `signal ${signal || 'unknown'}`;
      const detail = `${displayArgv.join(' ')}: ${reason}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`;
      reject(timedOut ? new GraphCheckTimeoutError(detail) : new GraphCheckCommandError(detail));
    });
  });
}
