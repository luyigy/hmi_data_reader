import { randomUUID } from 'node:crypto';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { sanitizePreview } from '@/lib/acpx/harness-events';
import { processPiJsonLine } from './ssh-executor';

const gatewayUrl = () => process.env.REMOTE_RUNNER_GATEWAY_URL?.trim() || 'http://127.0.0.1:3012';

export class RemoteRunnerGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function configureRemoteRunnerWorkspace(nodeName: string, workspace: string): Promise<string> {
  const response = await fetch(`${gatewayUrl()}/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeName, workspace }),
  });
  if (!response.ok) throw new RemoteRunnerGatewayError(response.status, await response.text() || `Remote runner HTTP ${response.status}`);
  const result = await response.json() as { workspace?: unknown };
  if (typeof result.workspace !== 'string') throw new RemoteRunnerGatewayError(502, 'Remote runner returned an invalid workspace');
  return result.workspace;
}

export interface RemoteRunnerResult {
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
}

export async function executeRemoteRunnerTask(options: {
  nodeName: string;
  taskId: string;
  cwd: string;
  prompt: string;
  sessionDir?: string;
  continuation?: boolean;
  timeout: number;
  streamCallbacks?: HarnessStreamCallbacks;
  onControl?: (control: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }) => void;
}): Promise<RemoteRunnerResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Remote runner timed out after ${options.timeout}ms`)), options.timeout);
  options.onControl?.({
    kill: () => {
      controller.abort(new Error('Remote runner interrupted'));
      return true;
    },
  });

  try {
    const response = await fetch(`${gatewayUrl()}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeName: options.nodeName,
        runId,
        taskId: options.taskId,
        cwd: options.cwd,
        prompt: options.prompt,
        sessionDir: options.sessionDir,
        continue: options.continuation,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(await response.text() || `Remote runner HTTP ${response.status}`);

    let buffer = '';
    let piBuffer = '';
    let result: Record<string, unknown> | null = null;
    let lastAssistantText = '';
    const callbacks: HarnessStreamCallbacks = {
      onStdoutChunk: (text) => {
        // Pi repeats the completed assistant message in message_end and turn_end.
        if (text === lastAssistantText) return;
        lastAssistantText = text;
        return options.streamCallbacks?.onStdoutChunk?.(sanitizePreview(text, { workspaceRoot: options.cwd }));
      },
      onToolEvent: (event) => options.streamCallbacks?.onToolEvent?.({
        ...event, preview: sanitizePreview(event.preview, { workspaceRoot: options.cwd }),
      }),
    };
    const consumePiLine = async (line: string, newline = '') => {
      const parsed = processPiJsonLine(line, callbacks);
      if (parsed.plainText) await callbacks.onStdoutChunk?.(parsed.plainText + newline);
    };
    const consumeEvent = async (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'stdout' && typeof event.data === 'string') {
        piBuffer += event.data;
        const lines = piBuffer.split('\n');
        piBuffer = lines.pop() || '';
        for (const piLine of lines) await consumePiLine(piLine, '\n');
      }
      if (event.type === 'stderr' && typeof event.data === 'string') await options.streamCallbacks?.onStderrChunk?.(event.data);
      return event.type === 'complete' ? event : null;
    };
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) result = await consumeEvent(line) || result;
    }
    result = await consumeEvent(buffer + decoder.decode()) || result;
    if (piBuffer.trim()) await consumePiLine(piBuffer);
    if (!result) throw new Error('Remote runner closed without a completion result');
    if (result.success !== true) throw new Error(typeof result.error === 'string' ? result.error : 'Remote runner failed');
    return {
      output: typeof result.output === 'string' ? result.output : 'Remote pi-agent completed',
      filesModified: Array.isArray(result.filesModified) ? result.filesModified.filter((v): v is string => typeof v === 'string') : [],
      executionTime: Date.now() - startedAt,
      liveStreaming: true,
      sessionId: typeof result.sessionDir === 'string' ? result.sessionDir : undefined,
      sessionKind: typeof result.sessionDir === 'string' ? 'pi_session_dir' : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
