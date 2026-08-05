import { execFile, spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';

export interface KimiCodeConfig {
  timeout?: number | null;
  workingDirectory?: string;
  workspaceRoot?: string;
  networkAccess?: 'restricted' | 'enabled';
  permissionProfile?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  model?: string;
  prompt?: string;
  sessionId?: string;
}

export interface KimiCodeTask {
  id: string;
  name: string;
  description?: string;
}

export interface KimiCodeResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
}

const getKimiCodeBinary = () => process.env.KIMI_CODE_CLI_PATH?.trim() || 'kimi';
export const getKimiCodeHome = () =>
  process.env.KIMI_CODE_HOME?.trim() || path.join(homedir(), '.kimi-code');

const buildPrompt = (task: KimiCodeTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

const processKimiCodeJsonLine = (
  line: string,
  state: { output: string; structuredError?: string; sessionId?: string },
  streamCallbacks?: HarnessStreamCallbacks
) => {
  let event: {
    role?: string;
    type?: string;
    content?: string;
    error?: string;
    message?: string;
    session_id?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    // Anthropic-style streaming fields
    name?: string;
    input?: unknown;
    content_block?: {
      type?: string;
      name?: string;
      input?: unknown;
    };
  };

  try {
    event = JSON.parse(line);
  } catch {
    state.structuredError = `Invalid Kimi Code stream-json output: ${line}`;
    return;
  }

  if (event.role === 'assistant' && typeof event.content === 'string') {
    state.output += event.content;
    void streamCallbacks?.onStdoutChunk?.(event.content);
  }
  if (event.role === 'assistant' && Array.isArray(event.tool_calls)) {
    for (const toolCall of event.tool_calls) {
      const toolName = toolCall.function?.name?.trim() || 'Task';
      const rawArguments = toolCall.function?.arguments;
      let input: unknown = rawArguments;
      if (rawArguments) {
        try {
          input = JSON.parse(rawArguments);
        } catch {
          // Keep malformed or non-JSON arguments as the best available preview.
        }
      }
      void streamCallbacks?.onToolEvent?.({
        toolName,
        preview: buildToolPreview(input) || rawArguments?.trim() || '',
        emoji: getToolEmoji(toolName),
      });
    }
  }

  // Also detect tool_use events (Anthropic-style streaming format)
  if (event.type === 'tool_use' && typeof event.name === 'string') {
    void streamCallbacks?.onToolEvent?.({
      toolName: event.name,
      preview: buildToolPreview(event.input) || '',
      emoji: getToolEmoji(event.name),
    });
  }

  // Detect content_block_start with tool_use (alternative format)
  if (
    event.type === 'content_block_start'
    && event.content_block?.type === 'tool_use'
    && typeof event.content_block?.name === 'string'
  ) {
    void streamCallbacks?.onToolEvent?.({
      toolName: event.content_block.name,
      preview: buildToolPreview(event.content_block.input) || '',
      emoji: getToolEmoji(event.content_block.name),
    });
  }

  if (
    event.role === 'meta'
    && event.type === 'session.resume_hint'
    && typeof event.session_id === 'string'
    && event.session_id.trim()
  ) {
    state.sessionId = event.session_id.trim();
  }

  if (
    typeof event.error === 'string'
    || ((event.type === 'error' || event.role === 'error') && typeof event.message === 'string')
  ) {
    state.structuredError =
      typeof event.error === 'string' ? event.error : event.message;
  }
};

const runKimiCodeCommand = async ({
  prompt,
  timeout,
  workingDirectory,
  workspaceRoot,
  networkAccess,
  permissionProfile,
  streamCallbacks,
  onSpawn,
  model,
  sessionId,
}: {
  prompt: string;
  timeout: number | null;
  workingDirectory: string;
  workspaceRoot?: string;
  networkAccess?: 'restricted' | 'enabled';
  permissionProfile?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  model?: string;
  sessionId?: string;
}): Promise<{ output: string; sessionId?: string }> => {
  if (!workspaceRoot && permissionProfile !== 'full_access') {
    throw new Error('Kimi Code requires Bubblewrap unless full access is explicitly selected.');
  }

  const env = { ...process.env };
  // Prompt mode is implicitly Kimi's fully autonomous `auto` mode; Bubblewrap is the safety boundary.
  const args = [
    '--prompt',
    prompt,
    '--output-format',
    'stream-json',
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--session', sessionId);

  const wrapped = wrapWithBubblewrap({
    command: getKimiCodeBinary(),
    commandArgs: args,
    cwd: workingDirectory,
    workspaceRoot,
    networkAccess,
    env,
    configPaths: [getKimiCodeHome()],
  });
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: workingDirectory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onSpawn?.(child);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let closed = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;
    const state: { output: string; structuredError?: string; sessionId?: string } = { output: '' };

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    if (typeof timeout === 'number' && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        forceKillHandle = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 2000);
        forceKillHandle.unref();
        if (!settled) {
          settled = true;
          reject(new Error(`Kimi Code execution timed out after ${timeout}ms`));
        }
      }, timeout);
    }

    child.stdout.on('data', (data) => {
      if (settled) return;
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) processKimiCodeJsonLine(line.trim(), state, streamCallbacks);
      }
    });

    child.stderr.on('data', (data) => {
      if (settled) return;
      const chunk = data.toString();
      stderr += chunk;
      void streamCallbacks?.onStderrChunk?.(chunk);
    });

    child.on('error', (error) => fail(`Failed to start Kimi Code CLI: ${error.message}`));
    child.on('close', (code) => {
      closed = true;
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (settled) return;
      if (stdoutBuffer.trim()) {
        processKimiCodeJsonLine(stdoutBuffer.trim(), state, streamCallbacks);
      }
      cleanup();
      if (code === 0 && !state.structuredError) {
        settled = true;
        resolve({
          output: state.output || 'Kimi Code completed',
          sessionId: state.sessionId,
        });
        return;
      }
      fail(
        state.structuredError
        || stderr.trim()
        || stdout.trim()
        || `Kimi Code exited with code ${code ?? 'unknown'}`
      );
    });
  });
};

export const executeKimiCodeTask = async (
  task: KimiCodeTask,
  config: KimiCodeConfig = {}
): Promise<KimiCodeResult> => {
  const startTime = Date.now();
  try {
    const result = await runKimiCodeCommand({
      prompt: config.prompt ?? buildPrompt(task),
      timeout: config.timeout === undefined ? 300000 : config.timeout,
      workingDirectory: config.workingDirectory || process.cwd(),
      workspaceRoot: config.workspaceRoot,
      networkAccess: config.networkAccess,
      permissionProfile: config.permissionProfile,
      streamCallbacks: config.streamCallbacks,
      onSpawn: config.onSpawn,
      model: config.model,
      sessionId: config.sessionId,
    });
    return {
      success: true,
      output: result.output,
      sessionId: result.sessionId,
      executionTime: Date.now() - startTime,
      filesModified: [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

export const isKimiCodeAvailable = async (): Promise<boolean> => {
  try {
    await promisify(execFile)(getKimiCodeBinary(), ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getKimiCodeVersion = async (): Promise<string> => {
  try {
    const { stdout } = await promisify(execFile)(getKimiCodeBinary(), ['--version'], {
      timeout: 5000,
    });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] || stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
};
