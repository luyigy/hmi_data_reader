import type { ChildProcess } from 'child_process';

interface LiveRoomRunningProcessEntry {
  deliveryId: string;
  roomId: string;
  memberId: string;
  sessionId: string;
  child: ChildProcess;
  executionBackend: string;
  harnessType: string;
  startedAt: number;
}

const globalRegistry = globalThis as unknown as {
  liveRoomRunningProcesses?: Map<string, LiveRoomRunningProcessEntry>;
  liveRoomExecutionChains?: Map<string, Promise<void>>;
  liveRoomExecutionGenerations?: Map<string, number>;
};

const getProcessStore = () => {
  if (!globalRegistry.liveRoomRunningProcesses) {
    globalRegistry.liveRoomRunningProcesses = new Map();
  }

  return globalRegistry.liveRoomRunningProcesses;
};

const getExecutionChainStore = () => {
  if (!globalRegistry.liveRoomExecutionChains) {
    globalRegistry.liveRoomExecutionChains = new Map();
  }

  return globalRegistry.liveRoomExecutionChains;
};

const getExecutionGenerationStore = () => {
  if (!globalRegistry.liveRoomExecutionGenerations) {
    globalRegistry.liveRoomExecutionGenerations = new Map();
  }

  return globalRegistry.liveRoomExecutionGenerations;
};

// ponytail: process-local serialization; move ownership to a DB-backed worker if
// more than one process starts consuming Live Room deliveries.
export const hasLiveRoomMemberExecution = (memberId: string) =>
  getExecutionChainStore().has(memberId);

export const registerLiveRoomRunningProcess = (entry: LiveRoomRunningProcessEntry) => {
  getProcessStore().set(entry.memberId, entry);
};

export const clearLiveRoomRunningProcess = (memberId: string, deliveryId?: string) => {
  const store = getProcessStore();
  const existing = store.get(memberId);

  if (!existing) {
    return;
  }

  if (deliveryId && existing.deliveryId !== deliveryId) {
    return;
  }

  store.delete(memberId);
};

export const getLiveRoomRunningProcess = (memberId: string) =>
  getProcessStore().get(memberId) ?? null;

export const interruptLiveRoomRunningProcess = (
  memberId: string,
  signal: NodeJS.Signals = 'SIGTERM'
) => {
  const entry = getLiveRoomRunningProcess(memberId);

  if (!entry) {
    return {
      applied: false,
      reason: 'process_not_found',
    } as const;
  }

  entry.child.kill(signal);

  return {
    applied: true,
    signal,
    deliveryId: entry.deliveryId,
  } as const;
};

export const cancelQueuedLiveRoomMemberExecutions = (memberId: string) => {
  const generations = getExecutionGenerationStore();
  generations.set(memberId, (generations.get(memberId) ?? 0) + 1);
};

export const waitForLiveRoomMemberExecutionStop = async (memberId: string, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (hasLiveRoomMemberExecution(memberId) || getLiveRoomRunningProcess(memberId)) {
    if (Date.now() >= deadline) throw new Error(`${memberId} old session stop timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

export const enqueueLiveRoomMemberExecution = async (
  memberId: string,
  task: () => Promise<void>,
  waitForCompletion = true
) => {
  const store = getExecutionChainStore();
  const generations = getExecutionGenerationStore();
  const generation = generations.get(memberId) ?? 0;
  const previous = store.get(memberId) ?? Promise.resolve();

  const current = previous
    .catch(() => undefined)
    .then(() => (generations.get(memberId) ?? 0) === generation ? task() : undefined)
    .finally(() => {
      if (store.get(memberId) === current) {
        store.delete(memberId);
      }
    });

  store.set(memberId, current);
  if (waitForCompletion) {
    await current;
  } else {
    void current.catch(() => undefined);
  }
};
