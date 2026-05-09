/**
 * Gemini CLI Agent Integration
 *
 * Uses Gemini CLI headless mode with stream-json output so ACPX/live-room can
 * capture incremental assistant text and reuse Gemini session ids.
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { ChildProcess } from 'child_process';

export interface GeminiConfig {
  timeout?: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  sandboxMode?: string;
  approvalPolicy?: 'never' | 'on-request';
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (sessionId: string) => void;
}

export interface GeminiTask {
  id: string;
  name: string;
  description?: string;
}

export interface GeminiResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
}

const GEMINI_BIN = process.env.GEMINI_CLI_PATH?.trim() || 'gemini';

const buildGeminiChildEnv = () => {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  const home = env.HOME || '/home/hello';
  const localBin = `${home}/.local/bin`;

  if (!env.PATH?.split(':').includes(localBin)) {
    env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;
  }

  const httpProxy = process.env.FEISHU_RUNTIME_CODEX_HTTP_PROXY?.trim();
  const httpsProxy = process.env.FEISHU_RUNTIME_CODEX_HTTPS_PROXY?.trim();
  const allProxy = process.env.FEISHU_RUNTIME_CODEX_ALL_PROXY?.trim();
  const noProxy = process.env.FEISHU_RUNTIME_CODEX_NO_PROXY?.trim();

  if (httpProxy) {
    env.http_proxy = httpProxy;
    env.HTTP_PROXY = httpProxy;
  }
  if (httpsProxy) {
    env.https_proxy = httpsProxy;
    env.HTTPS_PROXY = httpsProxy;
  }
  if (allProxy) {
    env.all_proxy = allProxy;
    env.ALL_PROXY = allProxy;
  }
  if (noProxy) {
    env.no_proxy = noProxy;
    env.NO_PROXY = noProxy;
  }

  // Reduce CLI warnings when running under non-interactive pipes.
  env.TERM = env.TERM || 'xterm-256color';
  env.FORCE_COLOR = env.FORCE_COLOR || '0';

  return env;
};

const buildPrompt = (task: GeminiTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

const resolveGeminiApprovalMode = () => 'yolo';

export const executeGeminiTask = async (
  task: GeminiTask,
  config: GeminiConfig = {}
): Promise<GeminiResult> => {
  const startTime = Date.now();

  try {
    const result = await runGeminiCommand({
      prompt: buildPrompt(task),
      timeout: config.timeout === null ? null : (config.timeout ?? 300000),
      workingDirectory: config.workingDirectory || process.cwd(),
      streamCallbacks: config.streamCallbacks,
      sandboxMode: config.sandboxMode || 'workspace-write',
      approvalPolicy: config.approvalPolicy || 'never',
      onSpawn: config.onSpawn,
      onSessionStarted: config.onSessionStarted,
    });

    return {
      success: true,
      output: result.output,
      filesModified: [],
      sessionId: result.sessionId,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

export const resumeGeminiSession = async ({
  sessionId,
  prompt,
  timeout,
  workingDirectory = process.cwd(),
  streamCallbacks,
  onSpawn,
  onSessionStarted,
  sandboxMode = 'workspace-write',
  approvalPolicy = 'never',
}: {
  sessionId: string;
  prompt: string;
  timeout: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (sessionId: string) => void;
  sandboxMode?: string;
  approvalPolicy?: 'never' | 'on-request';
}): Promise<GeminiResult> => {
  const startTime = Date.now();

  try {
    const result = await runGeminiCommand({
      prompt,
      timeout,
      workingDirectory,
      streamCallbacks,
      sandboxMode,
      approvalPolicy,
      onSpawn,
      onSessionStarted,
      resumeSessionId: sessionId,
    });

    return {
      success: true,
      output: result.output,
      filesModified: [],
      sessionId: result.sessionId,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

const handleGeminiJsonLine = ({
  line,
  state,
  streamCallbacks,
  onSessionStarted,
}: {
  line: string;
  state: {
    output: string;
    sessionId?: string;
    structuredError?: string | null;
  };
  streamCallbacks?: HarnessStreamCallbacks;
  onSessionStarted?: (sessionId: string) => void;
}) => {
  const event = JSON.parse(line) as {
    type?: string;
    role?: string;
    content?: string;
    delta?: boolean;
    status?: string;
    session_id?: string;
    error?: string;
    message?: string;
  };

  if (typeof event.session_id === 'string' && event.session_id.trim()) {
    state.sessionId = event.session_id.trim();
    onSessionStarted?.(state.sessionId);
  }

  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
    if (event.delta === true) {
      state.output += event.content;
      void streamCallbacks?.onStdoutChunk?.(event.content);
      return;
    }

    if (!state.output) {
      state.output = event.content;
      void streamCallbacks?.onStdoutChunk?.(event.content);
      return;
    }

    if (event.content.length >= state.output.length) {
      state.output = event.content;
    }

    return;
  }

  if (event.type === 'result' && event.status && event.status !== 'success') {
    state.structuredError = event.error || event.message || `Gemini exited with status: ${event.status}`;
  }
};

const flushGeminiStdoutBuffer = ({
  buffer,
  state,
  streamCallbacks,
  onSessionStarted,
}: {
  buffer: string;
  state: {
    output: string;
    sessionId?: string;
    structuredError?: string | null;
  };
  streamCallbacks?: HarnessStreamCallbacks;
  onSessionStarted?: (sessionId: string) => void;
}) => {
  const trimmed = buffer.trim();
  if (!trimmed) {
    return;
  }

  try {
    handleGeminiJsonLine({
      line: trimmed,
      state,
      streamCallbacks,
      onSessionStarted,
    });
  } catch {
    state.output = state.output || trimmed;
    void streamCallbacks?.onStdoutChunk?.(trimmed);
  }
};

const runGeminiCommand = async ({
  prompt,
  timeout,
  workingDirectory,
  streamCallbacks,
  sandboxMode,
  approvalPolicy,
  onSpawn,
  onSessionStarted,
  resumeSessionId,
}: {
  prompt: string;
  timeout: number | null;
  workingDirectory: string;
  streamCallbacks?: HarnessStreamCallbacks;
  sandboxMode: string;
  approvalPolicy: 'never' | 'on-request';
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (sessionId: string) => void;
  resumeSessionId?: string;
}): Promise<{ output: string; sessionId?: string }> => {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const args = [
      '--prompt',
      '',
      '--output-format',
      'stream-json',
      '--skip-trust',
      '--approval-mode',
      resolveGeminiApprovalMode(sandboxMode, approvalPolicy),
    ];

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    const shell = process.platform === 'win32';
    const child = spawn(GEMINI_BIN, args, {
      cwd: workingDirectory,
      env: buildGeminiChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });
    onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let closed = false;
    const state: {
      output: string;
      sessionId?: string;
      structuredError?: string | null;
    } = {
      output: '',
      structuredError: null,
    };

    const finishReject = (error: string) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(error));
    };

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        output: state.output || stdout.trim() || stderr.trim() || 'Gemini completed',
        sessionId: state.sessionId,
      });
    };

    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;
    if (typeof timeout === 'number' && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        state.structuredError = `Gemini execution timed out after ${timeout}ms`;
        child.kill('SIGTERM');
        forceKillHandle = setTimeout(() => {
          if (!closed) {
            child.kill('SIGKILL');
          }
        }, 2000);
        forceKillHandle.unref();
        finishReject(state.structuredError);
      }, timeout);
    }

    child.stdout.on('data', (data) => {
      if (settled) {
        return;
      }

      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          handleGeminiJsonLine({
            line: trimmed,
            state,
            streamCallbacks,
            onSessionStarted,
          });
        } catch {
          state.output = state.output || trimmed;
          void streamCallbacks?.onStdoutChunk?.(trimmed);
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (settled) {
        return;
      }

      const chunk = data.toString();
      stderr += chunk;
      void streamCallbacks?.onStderrChunk?.(chunk);
    });

    child.on('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }
      finishReject(`Failed to start Gemini CLI: ${error.message}`);
    });

    child.on('close', (code) => {
      closed = true;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }

      if (!settled) {
        flushGeminiStdoutBuffer({
          buffer: stdoutBuffer,
          state,
          streamCallbacks,
          onSessionStarted,
        });
      }

      if (code === 0 && !state.structuredError) {
        finishResolve();
        return;
      }

      finishReject(
        state.structuredError
          || stderr.trim()
          || stdout.trim()
          || `Gemini exited with code ${code ?? 'unknown'}`
      );
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
};

export const isGeminiAvailable = async (): Promise<boolean> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    await execAsync(`${GEMINI_BIN} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getGeminiVersion = async (): Promise<string> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(`${GEMINI_BIN} --version`, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};
