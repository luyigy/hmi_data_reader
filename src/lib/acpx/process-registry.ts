import type { RunControlAction } from './types';

interface RunningProcess {
  pid?: number;
  exitCode?: number | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface RunningProcessEntry {
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
  getProcessStore().set(getProcessKey(entry.participantId), entry);
};

export const clearRunningProcess = (participantId: string) => {
  getProcessStore().delete(getProcessKey(participantId));
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
  process.child.kill(signal);

  return {
    applied: true,
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
