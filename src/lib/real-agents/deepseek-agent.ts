/**
 * DeepSeek-TUI Agent Integration
 *
 * Phase 2A uses the local HTTP runtime so ACPX/live-room can reuse a stable
 * DeepSeek thread across follow-up messages.
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { ChildProcess } from 'child_process';
import { runDeepSeekRuntimeTurn } from './deepseek-runtime';

export interface DeepSeekConfig {
  timeout?: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  resumeThreadId?: string;
  onThreadStarted?: (threadId: string) => void;
}

export interface DeepSeekTask {
  id: string;
  name: string;
  description?: string;
}

export interface DeepSeekResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  threadId?: string;
}

const buildPrompt = (task: DeepSeekTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

export const executeDeepSeekTask = async (
  task: DeepSeekTask,
  config: DeepSeekConfig = {}
): Promise<DeepSeekResult> => {
  const startTime = Date.now();
  const {
    timeout = 30000,
    workingDirectory = process.cwd(),
    streamCallbacks,
    onSpawn,
  } = config;

  try {
    const result = await executeDeepSeekTurn(task, {
      timeout,
      workingDirectory,
      streamCallbacks,
      onSpawn,
      resumeThreadId: config.resumeThreadId,
      onThreadStarted: config.onThreadStarted,
    });

    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
      threadId: result.threadId,
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

export const resumeDeepSeekSession = async ({
  threadId,
  prompt,
  timeout,
  workingDirectory = process.cwd(),
  streamCallbacks,
  onSpawn,
  onThreadStarted,
}: {
  threadId: string;
  prompt: string;
  timeout: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => void;
}): Promise<DeepSeekResult> => {
  const startTime = Date.now();

  try {
    const result = await executeDeepSeekTurn(
      {
        id: 'continuation',
        name: 'DeepSeek continuation',
        description: prompt,
      },
      {
        timeout,
        workingDirectory,
        streamCallbacks,
        onSpawn,
        resumeThreadId: threadId,
        onThreadStarted,
        rawPrompt: prompt,
      }
    );

    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
      threadId: result.threadId,
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

const executeDeepSeekTurn = async (
  task: DeepSeekTask,
  options: {
    timeout: number | null;
    workingDirectory: string;
    streamCallbacks?: HarnessStreamCallbacks;
    onSpawn?: (child: ChildProcess) => void;
    resumeThreadId?: string;
    onThreadStarted?: (threadId: string) => void;
    rawPrompt?: string;
  }
): Promise<{ output: string; filesModified: string[]; threadId?: string }> => {
  const prompt = options.rawPrompt ?? buildPrompt(task);
  const result = await runDeepSeekRuntimeTurn({
    prompt,
    threadId: options.resumeThreadId,
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeout,
  });

  if (result.threadId) {
    options.onThreadStarted?.(result.threadId);
  }
  if (result.output) {
    void options.streamCallbacks?.onStdoutChunk?.(result.output);
  }

  return {
    output: result.output,
    filesModified: [],
    threadId: result.threadId,
  };
};

export const isDeepSeekAvailable = async (): Promise<boolean> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    await execAsync('deepseek --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getDeepSeekVersion = async (): Promise<string> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync('deepseek --version', { timeout: 5000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};
