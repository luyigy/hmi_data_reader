import type { SessionSizeSample } from '../session-size';

export interface NativeSessionBytes { bytes: number; identity: string; files?: Record<string, { bytes: number; identity: string }> }

export async function withNativeSessionSize<T>(scope: {
  executionId?: string; sessionId?: string; read: (sessionId: string) => Promise<NativeSessionBytes | null>; fresh?: boolean; ephemeral?: boolean;
  onSample?: (sample: SessionSizeSample) => Promise<void> | void;
}, run: (onSession: (id: string) => Promise<void>) => Promise<T>): Promise<T> {
  if (!scope.executionId || scope.ephemeral || !scope.onSample) return run(async () => {});
  let sessionId = scope.sessionId;
  const read = (id: string) => scope.read(id).catch(() => null);
  let baseline = sessionId ? await read(sessionId) : null;
  let fresh = scope.fresh ?? !scope.sessionId;
  let bound = false;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = Promise.resolve();
  const sample = () => {
    pending = pending.then(async () => {
      if (!bound || !sessionId) return;
      const sampledId = sessionId, sampledGeneration = generation;
      const size = await read(sampledId);
      if (!size || sampledGeneration !== generation) return;
      if (fresh && !baseline) baseline = { bytes: 0, identity: size.identity };
      if (baseline && (baseline.identity !== size.identity || size.bytes < baseline.bytes || Object.entries(baseline.files || {}).some(([key, previous]) => !size.files?.[key] || size.files[key].identity !== previous.identity || size.files[key].bytes < previous.bytes))) {
        baseline = null;
        fresh = false;
      }
      const deltaBytes = baseline && baseline.identity === size.identity && size.bytes >= baseline.bytes
        ? size.bytes - baseline.bytes : undefined;
      await scope.onSample!({ executionId: scope.executionId!, sessionId: sampledId, totalBytes: size.bytes,
        ...(deltaBytes === undefined ? {} : { deltaBytes }), observedAt: Date.now() });
    }).catch(() => { console.warn('Session size telemetry unavailable'); });
    return pending;
  };
  try {
    return await run(async id => {
      if (sessionId !== id) generation++;
      if (sessionId && sessionId !== id) { baseline = null; fresh = false; }
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
