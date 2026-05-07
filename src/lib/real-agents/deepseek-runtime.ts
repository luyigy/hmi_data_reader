import { spawn, type ChildProcess } from 'child_process';

const DEFAULT_DEEPSEEK_RUNTIME_HOST = process.env.DEEPSEEK_RUNTIME_HOST?.trim() || '127.0.0.1';
const DEFAULT_DEEPSEEK_RUNTIME_PORT = Number(process.env.DEEPSEEK_RUNTIME_PORT?.trim() || '7788');
const DEFAULT_DEEPSEEK_RUNTIME_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_DEEPSEEK_RUNTIME_POLL_INTERVAL_MS = 750;

type DeepSeekRuntimeThread = {
  id: string;
  workspace?: string;
  latest_turn_id?: string;
};

type DeepSeekRuntimeTurn = {
  id: string;
  status: string;
};

type DeepSeekRuntimeItem = {
  id: string;
  turn_id?: string;
  kind?: string;
  status?: string;
  detail?: string;
  summary?: string;
};

type DeepSeekThreadReadResponse = {
  thread?: DeepSeekRuntimeThread;
  turns?: DeepSeekRuntimeTurn[];
  items?: DeepSeekRuntimeItem[];
};

let runtimeProcess: ChildProcess | null = null;
let runtimeReadyPromise: Promise<string> | null = null;

const getRuntimeBaseUrl = () => `http://${DEFAULT_DEEPSEEK_RUNTIME_HOST}:${DEFAULT_DEEPSEEK_RUNTIME_PORT}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const raw = await response.text();

  if (!response.ok) {
    let message = raw || `${response.status} ${response.statusText}`;
    try {
      const parsed = raw ? JSON.parse(raw) as { error?: { message?: string } } : null;
      if (parsed?.error?.message) {
        message = parsed.error.message;
      }
    } catch {
      // Keep raw text if parsing fails.
    }
    throw new Error(message);
  }

  return raw ? JSON.parse(raw) as T : {} as T;
};

const pingRuntime = async (baseUrl: string) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`${baseUrl}/v1/threads`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
};

const waitForRuntimeReady = async (baseUrl: string, timeoutMs: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pingRuntime(baseUrl)) {
      return baseUrl;
    }
    await sleep(250);
  }

  throw new Error(`DeepSeek runtime did not become ready within ${timeoutMs}ms`);
};

export const ensureDeepSeekRuntime = async () => {
  const baseUrl = getRuntimeBaseUrl();

  if (await pingRuntime(baseUrl)) {
    return baseUrl;
  }

  if (runtimeReadyPromise) {
    return runtimeReadyPromise;
  }

  runtimeReadyPromise = (async () => {
    const child = spawn(
      'deepseek',
      [
        'serve',
        '--',
        '--http',
        '--host',
        DEFAULT_DEEPSEEK_RUNTIME_HOST,
        '--port',
        String(DEFAULT_DEEPSEEK_RUNTIME_PORT),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }
    );

    runtimeProcess = child;

    let startupLog = '';
    child.stdout.on('data', (chunk) => {
      startupLog += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      startupLog += chunk.toString();
    });

    try {
      return await waitForRuntimeReady(baseUrl, DEFAULT_DEEPSEEK_RUNTIME_STARTUP_TIMEOUT_MS);
    } catch (error) {
      runtimeProcess = null;
      throw new Error(
        startupLog.trim()
          ? `Failed to start DeepSeek runtime: ${startupLog.trim()}`
          : error instanceof Error
          ? error.message
          : 'Failed to start DeepSeek runtime'
      );
    }
  })();

  try {
    return await runtimeReadyPromise;
  } finally {
    runtimeReadyPromise = null;
  }
};

export const createDeepSeekRuntimeThread = async ({
  workingDirectory,
}: {
  workingDirectory?: string;
}) => {
  const baseUrl = await ensureDeepSeekRuntime();

  return fetchJson<DeepSeekRuntimeThread>(`${baseUrl}/v1/threads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'agent',
      workspace: workingDirectory || process.cwd(),
    }),
  });
};

const readDeepSeekRuntimeThread = async (threadId: string) => {
  const baseUrl = await ensureDeepSeekRuntime();
  return fetchJson<DeepSeekThreadReadResponse>(`${baseUrl}/v1/threads/${threadId}`);
};

const extractTurnOutput = (payload: DeepSeekThreadReadResponse, turnId: string) => {
  const outputItems = (payload.items || []).filter((item) =>
    item.turn_id === turnId
    && item.kind === 'agent_message'
    && item.status === 'completed'
  );
  const latestItem = outputItems[outputItems.length - 1];
  return latestItem?.detail?.trim() || latestItem?.summary?.trim() || '';
};

export const runDeepSeekRuntimeTurn = async ({
  prompt,
  threadId,
  workingDirectory,
  timeoutMs,
}: {
  prompt: string;
  threadId?: string;
  workingDirectory?: string;
  timeoutMs?: number | null;
}) => {
  const baseUrl = await ensureDeepSeekRuntime();
  const resolvedThreadId = threadId || (await createDeepSeekRuntimeThread({ workingDirectory })).id;

  const turnResponse = await fetchJson<{
    thread?: DeepSeekRuntimeThread;
    turn?: DeepSeekRuntimeTurn;
  }>(`${baseUrl}/v1/threads/${resolvedThreadId}/turns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
    }),
  });

  const turnId = turnResponse.turn?.id;
  if (!turnId) {
    throw new Error('DeepSeek runtime did not return a turn id');
  }

  const startedAt = Date.now();

  while (true) {
    const threadState = await readDeepSeekRuntimeThread(resolvedThreadId);
    const turn = (threadState.turns || []).find((candidate) => candidate.id === turnId);

    if (turn?.status === 'completed') {
      return {
        threadId: resolvedThreadId,
        turnId,
        output: extractTurnOutput(threadState, turnId),
      };
    }

    if (turn?.status === 'failed' || turn?.status === 'cancelled') {
      throw new Error(`DeepSeek turn ${turnId} ${turn.status}`);
    }

    if (typeof timeoutMs === 'number' && timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw new Error(`DeepSeek execution timed out after ${timeoutMs}ms`);
    }

    await sleep(DEFAULT_DEEPSEEK_RUNTIME_POLL_INTERVAL_MS);
  }
};
