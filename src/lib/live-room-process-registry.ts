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

export const enqueueLiveRoomMemberExecution = async (
  memberId: string,
  task: () => Promise<void>
) => {
  const store = getExecutionChainStore();
  const previous = store.get(memberId) ?? Promise.resolve();

  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (store.get(memberId) === current) {
        store.delete(memberId);
      }
    });

  store.set(memberId, current);
  await current;
};
