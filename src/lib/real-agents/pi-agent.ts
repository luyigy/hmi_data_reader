import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { sanitizePreview } from '@/lib/acpx/harness-events';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPiRpc } from './pi-rpc';
import { normalizeMemberModelSettings, splitPiModel } from '../live-room-codex-settings';
import { collectPiRuntimeState } from './pi-runtime-state';
import type { HarnessRuntimeState } from '@/lib/harness/types';

export interface PiAgentConfig {
  executionId?: string;
  model?: string;
  reasoningEffort?: string;
  timeout?: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  sessionDir?: string;
  continueSession?: boolean;
}

export interface PiAgentTask {
  id: string;
  name: string;
  description?: string;
}

export interface PiAgentResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionDir?: string;
  runtimeState?: HarnessRuntimeState;
}

const DEFAULT_PI_AGENT_BIN = process.env.PI_AGENT_BIN?.trim() || '/data1/code/pi-mono/pi-test.sh';
const DEFAULT_PI_PROVIDER = process.env.PI_AGENT_PROVIDER?.trim();
const DEFAULT_PI_MODEL = process.env.PI_AGENT_MODEL?.trim();
const DEFAULT_PI_THINKING = process.env.PI_AGENT_THINKING?.trim();
const DEFAULT_PI_EXTENSIONS = (process.env.PI_AGENT_EXTENSIONS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const DEFAULT_PI_SESSION_ROOT = process.env.PI_AGENT_SESSION_ROOT?.trim()
  || path.join(os.homedir(), '.acpx', 'pi-agent-sessions');

const buildPrompt = (task: PiAgentTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

const slugify = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'default';

export const resolvePiAgentSessionDir = (sessionKey: string) =>
  path.join(DEFAULT_PI_SESSION_ROOT, slugify(sessionKey));

const buildPiArgs = ({
  prompt,
  sessionDir,
  continueSession,
  mode = 'json',
  model,
  reasoningEffort,
}: {
  prompt: string;
  sessionDir?: string;
  continueSession?: boolean;
  mode?: 'json' | 'print' | 'rpc';
  model?: string;
  reasoningEffort?: string;
}) => {
  const args = mode === 'print' ? ['--print'] : ['--mode', mode];
  const settings = normalizeMemberModelSettings({ model, reasoningEffort }, 'pi-agent', 'platform_local');
  const selection = splitPiModel(settings.model);
  const provider = selection.provider || DEFAULT_PI_PROVIDER;
  const selectedModel = selection.model || DEFAULT_PI_MODEL;
  const thinking = settings.reasoningEffort || DEFAULT_PI_THINKING;

  if (provider) {
    args.push('--provider', provider);
  }

  if (selectedModel) {
    args.push('--model', selectedModel);
  }

  if (thinking) {
    args.push('--thinking', thinking);
  }

  for (const extensionPath of DEFAULT_PI_EXTENSIONS) {
    args.push('--extension', extensionPath);
  }

  if (sessionDir) {
    args.push('--session-dir', sessionDir);
  }

  if (continueSession) {
    args.push('--continue');
  }

  args.push('--tools', 'read,bash,edit,write,grep,find,ls');
  if (mode !== 'rpc') args.push(prompt);
  return args;
};

interface PiJsonEvent {
  type?: string;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  args?: unknown;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

const normalizeToolName = (value?: string) => {
  const name = value?.trim() || 'Task';
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const processPiJsonLine = (
  line: string,
  workingDirectory: string,
  streamCallbacks?: HarnessStreamCallbacks
) => {
  try {
    const event = JSON.parse(line) as PiJsonEvent;
    const assistantText = event.message?.role === 'assistant' && Array.isArray(event.message.content)
      ? event.message.content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('')
      : '';

    if (assistantText) {
      void streamCallbacks?.onStdoutChunk?.(
        sanitizePreview(assistantText, { workspaceRoot: workingDirectory })
      );
    }

    if (event.type === 'tool_execution_start') {
      const toolName = normalizeToolName(event.toolName);
      void streamCallbacks?.onToolEvent?.({
        toolName,
        preview: sanitizePreview(buildToolPreview(event.args), { workspaceRoot: workingDirectory }),
        emoji: getToolEmoji(toolName),
      });
    } else if (event.type === 'tool_execution_end') {
      void streamCallbacks?.onToolEvent?.({ toolName: 'Tool Result', preview: '', emoji: '✅' });
    }

    return {
      assistantText: assistantText || undefined,
      errorMessage: event.stopReason === 'error' ? event.errorMessage?.trim() || 'Pi Agent failed' : undefined,
    };
  } catch {
    return undefined;
  }
};

const jsonModeUnavailable = (value: string) =>
  /(?:unknown|unrecognized|unsupported|invalid)[^\n]*(?:--mode|mode[^\n]*json)|--mode[^\n]*(?:unknown|unrecognized|unsupported|invalid)/i.test(value);

const runPiAgentCommand = async ({
  model,
  reasoningEffort,
  prompt,
  timeout,
  workingDirectory,
  streamCallbacks,
  onSpawn,
  sessionDir,
  continueSession,
}: {
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  timeout: number | null;
  workingDirectory: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  sessionDir?: string;
  continueSession?: boolean;
}): Promise<{ output: string; sessionFile?: string; sessionId?: string }> => {
  const { spawn } = await import('child_process');

  if (sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  if (streamCallbacks?.onSteeringReady) {
    let state: { sessionFile?: string; sessionId?: string } = {};
    const output = await runPiRpc({
      binary: DEFAULT_PI_AGENT_BIN,
      args: buildPiArgs({ prompt, sessionDir, continueSession, model, reasoningEffort, mode: 'rpc' }),
      prompt, timeout, workingDirectory, streamCallbacks, onSpawn,
      onEvent: (line) => { processPiJsonLine(line, workingDirectory, streamCallbacks); },
      onState: (next) => { state = next; },
    });
    return { output, ...state };
  }

  const run = (mode: 'json' | 'print') => new Promise<{ output: string; sessionId?: string }>((resolve, reject) => {
    const child = spawn(DEFAULT_PI_AGENT_BIN, buildPiArgs({ prompt, sessionDir, continueSession, model, reasoningEffort, mode }), {
      cwd: workingDirectory,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let resolvedText = '';
    let resolvedError = '';
    let sessionId: string | undefined;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      fn();
    };

    if (timeout !== null) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        settle(() => reject(new Error(`Pi Agent execution timed out after ${timeout}ms`)));
      }, timeout);
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      if (mode === 'print') {
        void streamCallbacks?.onStdoutChunk?.(text);
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!sessionId) {
          try { const header = JSON.parse(line); if (header.type === 'session' && typeof header.id === 'string') sessionId = header.id; } catch { /* Invalid event is ignored below. */ }
        }
        const event = processPiJsonLine(line, workingDirectory, streamCallbacks);
        if (event?.assistantText) {
          resolvedText = event.assistantText;
          resolvedError = '';
        } else if (event?.errorMessage) {
          resolvedError = event.errorMessage;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      void streamCallbacks?.onStderrChunk?.(text);
    });

    child.on('error', (error) => {
      settle(() => reject(error));
    });

    child.on('close', (code) => {
      if (mode === 'json' && stdoutBuffer.trim()) {
        const event = processPiJsonLine(stdoutBuffer, workingDirectory, streamCallbacks);
        if (event?.assistantText) {
          resolvedText = event.assistantText;
          resolvedError = '';
        } else if (event?.errorMessage) {
          resolvedError = event.errorMessage;
        }
      }
      const combined = (mode === 'json' ? resolvedText : stdout).trim();
      const normalizedStderr = stderr.trim();
      if (code === 0) {
        if (mode === 'json' && resolvedError) {
          settle(() => reject(new Error(resolvedError)));
          return;
        }
        settle(() => resolve({ output: combined || normalizedStderr || 'Pi Agent completed', sessionId }));
        return;
      }

      const errorMessage = normalizedStderr || stdout.trim() || `Pi Agent exited with code ${code ?? 'unknown'}`;
      settle(() => reject(new Error(errorMessage)));
    });
  });

  try {
    return await run('json');
  } catch (error) {
    if (!jsonModeUnavailable(error instanceof Error ? error.message : String(error))) throw error;
    return run('print');
  }
};

export const executePiAgentTask = async (
  task: PiAgentTask,
  config: PiAgentConfig = {}
): Promise<PiAgentResult> => {
  const startTime = Date.now();

  try {
    const run = await runPiAgentCommand({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      prompt: buildPrompt(task),
      timeout: config.timeout ?? null,
      workingDirectory: config.workingDirectory || process.cwd(),
      streamCallbacks: config.streamCallbacks,
      onSpawn: config.onSpawn,
      sessionDir: config.sessionDir,
      continueSession: config.continueSession,
    });

    return {
      success: true,
      output: run.output,
      filesModified: [],
      sessionDir: config.sessionDir,
      executionTime: Date.now() - startTime,
      runtimeState: config.sessionDir ? await collectPiRuntimeState({ executionId: config.executionId,
        sessionDir: config.sessionDir, sessionFile: run.sessionFile, sessionId: run.sessionId,
        startedAt: startTime, completedAt: Date.now() }) : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionDir: config.sessionDir,
      executionTime: Date.now() - startTime,
    };
  }
};

export const resumePiAgentSession = async ({
  executionId,
  model,
  reasoningEffort,
  sessionDir,
  prompt,
  timeout,
  workingDirectory = process.cwd(),
  streamCallbacks,
  onSpawn,
}: {
  executionId?: string;
  sessionDir: string;
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  timeout: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
}): Promise<PiAgentResult> => {
  const startTime = Date.now();

  try {
    const run = await runPiAgentCommand({
      model,
      reasoningEffort,
      prompt,
      timeout,
      workingDirectory,
      streamCallbacks,
      onSpawn,
      sessionDir,
      continueSession: true,
    });

    return {
      success: true,
      output: run.output,
      filesModified: [],
      sessionDir,
      executionTime: Date.now() - startTime,
      runtimeState: await collectPiRuntimeState({ executionId, sessionDir,
        sessionFile: run.sessionFile, sessionId: run.sessionId,
        startedAt: startTime, completedAt: Date.now() }),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionDir,
      executionTime: Date.now() - startTime,
    };
  }
};

export const isPiAgentAvailable = async (): Promise<boolean> => {
  try {
    await fs.promises.access(DEFAULT_PI_AGENT_BIN, fs.constants.X_OK);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(DEFAULT_PI_AGENT_BIN, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getPiAgentVersion = async (): Promise<string> => {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(DEFAULT_PI_AGENT_BIN, ['--version'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};
