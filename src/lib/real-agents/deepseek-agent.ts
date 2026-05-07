/**
 * DeepSeek-TUI Agent Integration
 *
 * Executes tasks using DeepSeek-TUI via its non-interactive JSON mode.
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { ChildProcess } from 'child_process';

export interface DeepSeekConfig {
  timeout?: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
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
}

const buildPrompt = (task: DeepSeekTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

const parseDeepSeekExecOutput = (stdout: string) => {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return {
      output: '',
      filesModified: [] as string[],
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      output?: unknown;
      success?: unknown;
      error?: unknown;
    };

    if (parsed.success === false) {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : 'DeepSeek execution failed');
    }

    const output = typeof parsed.output === 'string' ? parsed.output.trim() : trimmed;
    return {
      output,
      filesModified: [] as string[],
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'DeepSeek execution failed') {
      throw error;
    }

    return {
      output: trimmed,
      filesModified: [] as string[],
    };
  }
};

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
    const result = await executeDeepSeekCLI(task, {
      timeout,
      workingDirectory,
      streamCallbacks,
      onSpawn,
    });

    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
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

const executeDeepSeekCLI = async (
  task: DeepSeekTask,
  options: {
    timeout: number | null;
    workingDirectory: string;
    streamCallbacks?: HarnessStreamCallbacks;
    onSpawn?: (child: ChildProcess) => void;
  }
): Promise<{ output: string; filesModified: string[] }> => {
  const { spawn } = await import('child_process');
  const prompt = buildPrompt(task);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('deepseek', ['exec', '--', '--json', prompt], {
      cwd: options.workingDirectory,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    options.onSpawn?.(child);

    const timeoutId = typeof options.timeout === 'number' && options.timeout > 0
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`DeepSeek execution timed out after ${options.timeout}ms`));
        }, options.timeout)
      : null;

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      void options.streamCallbacks?.onStderrChunk?.(chunk);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `DeepSeek exited with code ${code}`));
        return;
      }

      try {
        const parsed = parseDeepSeekExecOutput(stdout);
        if (parsed.output) {
          void options.streamCallbacks?.onStdoutChunk?.(parsed.output);
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });
  });
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
