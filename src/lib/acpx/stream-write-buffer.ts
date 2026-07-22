export type StreamWrite = {
  stream: 'stdout' | 'stderr';
  content: string;
  interactionDetected: boolean;
};

export const compactStreamWrites = (writes: StreamWrite[]) =>
  writes.reduce<StreamWrite[]>((compacted, write) => {
    const previous = compacted[compacted.length - 1];
    if (previous?.stream === write.stream && previous.interactionDetected === write.interactionDetected) {
      previous.content += write.content;
    } else {
      compacted.push({ ...write });
    }
    return compacted;
  }, []);

export const createStreamWriteBuffer = (
  persist: (writes: StreamWrite[]) => Promise<void>,
  delayMs = 100
) => {
  let queued: StreamWrite[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let failure: unknown;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const writes = queued;
    queued = [];
    if (writes.length) {
      pending = pending.then(() => persist(compactStreamWrites(writes))).catch((error) => {
        failure = error;
      });
    }
    await pending;
    if (failure) throw failure;
  };

  return {
    push(write: StreamWrite) {
      queued.push(write);
      timer ??= setTimeout(() => void flush().catch(() => undefined), delayMs);
    },
    drain: flush,
  };
};
