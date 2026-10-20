import type { RunControlAction } from './types';

export interface RunningProcess {
  pid?: number;
  exitCode?: number | null;
  killed?: boolean;
  readonly closed?: boolean;
  onClosed?(listener: () => void): () => void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RunningProcessEntry {
  taskRunId: string;
  participantId: string;
  child: RunningProcess;
  executionBackend: string;
  harnessType: string;
}

const globalRegistry = globalThis as unknown as {
  acpxRunningProcesses?: Map<string, RunningProcessEntry>;
  acpxRunControlRequests?: Map<string, RunControlAction>;
};

const getProcessStore = () => {
  if (!globalRegistry.acpxRunningProcesses) {
    globalRegistry.acpxRunningProcesses = new Map();
  }
  return globalRegistry.acpxRunningProcesses;
};

const getControlStore = () => {
  if (!globalRegistry.acpxRunControlRequests) {
    globalRegistry.acpxRunControlRequests = new Map();
  }
  return globalRegistry.acpxRunControlRequests;
};

const getProcessKey = (participantId: string) => participantId;

export const registerRunningProcess = (entry: RunningProcessEntry) => {
  const store = getProcessStore();
  const key = getProcessKey(entry.participantId);
  store.set(key, entry);
  entry.child.onClosed?.(() => {
    if (store.get(key) === entry) store.delete(key);
  });
};

export const clearRunningProcess = (participantId: string, expectedTaskRunId?: string) => {
  const store = getProcessStore();
  const key = getProcessKey(participantId);
  const entry = store.get(key);
  if (expectedTaskRunId !== undefined && entry?.taskRunId !== expectedTaskRunId) return;
  if (entry?.child.onClosed && !entry.child.closed) return;
  store.delete(key);
};

export const getRunningProcess = (participantId: string) =>
  getProcessStore().get(getProcessKey(participantId)) ?? null;

export const requestRunControl = (
  taskRunId: string,
  participantId: string,
  action: RunControlAction
) => {
  const process = getRunningProcess(participantId);
  getControlStore().set(participantId, action);

  if (!process || process.taskRunId !== taskRunId) {
    return {
      applied: false,
      reason: 'process_not_found',
    };
  }

  const signal = action === 'stop_run' ? 'SIGKILL' : 'SIGINT';
  const requested = process.child.kill(signal);
  if (process.child.onClosed && !requested && getControlStore().get(participantId) === action) {
    getControlStore().delete(participantId);
  }

  return {
    applied: process.child.onClosed ? requested : true,
    signal,
  };
};

export const consumeRunControlRequest = (participantId: string) => {
  const store = getControlStore();
  const action = store.get(participantId) ?? null;
  if (action) {
    store.delete(participantId);
  }
  return action;
};
