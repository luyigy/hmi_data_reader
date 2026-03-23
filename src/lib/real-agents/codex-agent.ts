/**
 * Codex Agent Integration
 * 
 * Executes tasks using OpenAI Codex via CLI
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';

export interface CodexConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  skipGitRepoCheck?: boolean;
}

export interface CodexTask {
  id: string;
  name: string;
  description?: string;
}

export interface CodexResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
}

/**
 * Execute a task using Codex
 */
export const executeCodexTask = async (
  task: CodexTask,
  config: CodexConfig = {}
): Promise<CodexResult> => {
  const startTime = Date.now();
  const {
    apiKey = process.env.OPENAI_API_KEY,
    model = 'gpt-4',
    timeout = 30000,
    workingDirectory = process.cwd(),
    streamCallbacks,
    skipGitRepoCheck = true,
  } = config;

  try {
    console.log(`[Codex] Executing task: ${task.name}`);

    // Method 1: Using codex CLI directly
    const result = await executeCodexCLI(task, {
      timeout,
      workingDirectory,
      streamCallbacks,
      skipGitRepoCheck,
    });
    
    return {
      success: true,
      output: result,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[Codex] Execution failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

/**
 * Execute using codex CLI with exec subcommand
 */
const executeCodexCLI = async (
  task: CodexTask,
  options: {
    timeout: number;
    workingDirectory: string;
    streamCallbacks?: HarnessStreamCallbacks;
    skipGitRepoCheck: boolean;
  }
): Promise<string> => {
  const { spawn } = await import('child_process');
  
  // Create prompt for Codex - ensure complete message
  const prompt = `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const args = ['exec'];

    if (options.skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    
    // Use 'codex exec' subcommand which reads from stdin
    const child = spawn('codex', args, {
      cwd: options.workingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      console.log('[Codex] Timeout, killing process');
      child.kill('SIGTERM');
      reject(new Error(`Codex execution timed out after ${options.timeout}ms`));
    }, options.timeout);

    // Send prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();
    
    console.log('[Codex] Sending prompt via exec:', prompt.substring(0, 100) + '...');
    console.log('[Codex] Exec args:', args.join(' '));
    console.log('[Codex] Working directory:', options.workingDirectory);

    // Collect stdout
    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      void options.streamCallbacks?.onStdoutChunk?.(chunk);
    });

    // Collect stderr
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      void options.streamCallbacks?.onStderrChunk?.(chunk);
    });

    // Handle completion
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      console.log('[Codex] Process exited with code:', code);
      console.log('[Codex] Stdout length:', stdout.length);
      console.log('[Codex] Stderr:', stderr);
      
      if (code === 0 || stdout.length > 0) {
        resolve(stdout || 'Task executed successfully');
      } else {
        reject(new Error(stderr || `Codex exited with code ${code}`));
      }
    });

    // Handle errors
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      console.error('[Codex] Spawn error:', err);
      reject(err);
    });
  });
};

/**
 * Escape shell special characters
 */
const escapeShell = (str: string): string => {
  return str.replace(/['"\\$`]/g, '\\$&');
};

/**
 * Check if Codex is available
 */
export const isCodexAvailable = async (): Promise<boolean> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    await execAsync('codex --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Get Codex version
 */
export const getCodexVersion = async (): Promise<string> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync('codex --version', { timeout: 5000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};
