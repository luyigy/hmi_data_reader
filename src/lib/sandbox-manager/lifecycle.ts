import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sameSandboxIdentity, type SandboxIdentity } from './identity';

export interface ManagedProcessControl {
  readonly identity: SandboxIdentity | null;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly closed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  onClosed(listener: () => void): () => void;
}
export type StopRequest = { signal?: NodeJS.Signals | number; deadlineMonotonicMs: number };
export type RootExit =
  | { kind: 'exited'; identity: SandboxIdentity | null; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'unknown'; identity: SandboxIdentity | null; reason: string };
export type ManagedSandboxProcess = {
  child: ChildProcess; control: ManagedProcessControl; identity: SandboxIdentity | null;
  stop(request: StopRequest): Promise<RootExit>;
};
export type SandboxScopeOptions = { onSpawn?: (control: ManagedProcessControl) => void };
export interface SandboxBackend {
  start(): ChildProcess;
  captureIdentity(pid: number): SandboxIdentity;
  cleanup(): Promise<void>;
}
export type SandboxCleanupOutcome = {
  kind: 'completed' | 'failed';
  errors: readonly unknown[];
};
export class SandboxScopeError extends Error {
  readonly errors: readonly unknown[];
  constructor(
    readonly causes: readonly unknown[],
    readonly cleanupCompletion: Promise<SandboxCleanupOutcome> = Promise.resolve({ kind: 'failed', errors: causes }),
  ) {
    super(`Sandbox scope failed: ${causes.map(cause => cause instanceof Error ? cause.message : String(cause)).join('; ')}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SandboxScopeError'; this.errors = causes;
  }
}

/** Internal backend seam. The public entry point always selects Bubblewrap. */
export async function runSandboxScope<T>(backend: SandboxBackend, use: (process: ManagedSandboxProcess) => Promise<T>, stopTimeoutMs = 5000, options: SandboxScopeOptions = {}): Promise<T> {
  let child: ChildProcess;
  try { child = backend.start(); }
  catch (error) {
    try { await backend.cleanup(); } catch (cleanupError) { throw new SandboxScopeError([error, cleanupError]); }
    throw error;
  }
  let identity: SandboxIdentity | null = null;
  let identityError: unknown;
  let close: Extract<RootExit, { kind: 'exited' }> | undefined;
  const listeners = new Set<() => void>();
  const processErrors: unknown[] = [];
  let cleanup: Promise<void> | undefined;
  let cleanupError: unknown;
  let cleanupFailed = false;
  let scopeReleased = false;
  let scopeErrors: unknown[] = [];
  let completeCleanup!: (outcome: SandboxCleanupOutcome) => void;
  const cleanupCompletion = new Promise<SandboxCleanupOutcome>(resolve => { completeCleanup = resolve; });
  const startCleanup = () => cleanup ??= Promise.resolve().then(() => backend.cleanup())
    .catch(error => { cleanupFailed = true; cleanupError = error; })
    .then(() => completeCleanup({
      kind: cleanupFailed ? 'failed' : 'completed',
      errors: cleanupFailed ? [...scopeErrors, cleanupError] : [...scopeErrors],
    }));
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.on('error', error => { processErrors.push(error); reject(error); });
  });
  child.once('close', (code, signal) => {
    close = { kind: 'exited', identity, code, signal };
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch (error) { processErrors.push(error); }
    }
    listeners.clear();
    if (scopeReleased) void startCleanup();
  });
  try { if (child.pid !== undefined) identity = backend.captureIdentity(child.pid); }
  catch (error) { identityError = error; }
  let signalError: unknown;
  const control: ManagedProcessControl = {
    get identity() { return identity; },
    get pid() { return child.pid; }, get exitCode() { return child.exitCode; },
    get killed() { return child.killed; }, get closed() { return close !== undefined; },
    onClosed(listener) {
      if (close) { listener(); return () => {}; }
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    kill(signal = 'SIGTERM') {
      if (close) return false;
      try {
        if (!identity) throw identityError || new Error('Sandbox root identity unavailable');
        if (!sameSandboxIdentity(identity, backend.captureIdentity(identity.root.pid))) throw new Error('Sandbox root identity changed');
        signalError = undefined;
        return child.kill(signal);
      } catch (error) { signalError = error; return false; }
    },
  };
  const stop = async (request: StopRequest): Promise<RootExit> => {
    if (close) return close;
    if (!Number.isFinite(request.deadlineMonotonicMs)) return { kind: 'unknown', identity, reason: 'Invalid stop deadline' };
    control.kill(request.signal);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve({ kind: 'unknown', identity, reason: `Sandbox root close unknown: ${signalError instanceof Error ? signalError.message : 'stop deadline exceeded'}` });
      }, Math.max(0, request.deadlineMonotonicMs - performance.now()));
      const unsubscribe = control.onClosed(() => { clearTimeout(timer); resolve(close!); });
    });
  };
  let result!: T;
  let failed = false;
  let primary: unknown;
  try {
    options.onSpawn?.(control);
    await started;
    if (identityError && !close) throw identityError;
    result = await use({ child, control, identity, stop });
  } catch (error) { failed = true; primary = error; }
  await started.catch(() => {});
  const outcome = await stop({ signal: 'SIGTERM', deadlineMonotonicMs: performance.now() + stopTimeoutMs });
  const errors = scopeErrors = failed ? [primary] : [];
  for (const error of processErrors) if (!errors.includes(error)) errors.push(error);
  if (outcome.kind === 'unknown') {
    scopeReleased = true;
    if (close) void startCleanup();
    errors.push(new Error(`${outcome.reason}; identity=${JSON.stringify(identity)}`));
  }
  else {
    await startCleanup();
    if (cleanupFailed) errors.push(cleanupError);
  }
  if (errors.length === 1 && failed && errors[0] === primary) throw primary;
  if (errors.length) throw new SandboxScopeError(errors, cleanupCompletion);
  return result;
}
