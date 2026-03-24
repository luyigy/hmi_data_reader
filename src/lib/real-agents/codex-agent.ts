/**
 * Codex Agent Integration
 * 
 * Executes tasks using OpenAI Codex via CLI
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { ChildProcess } from 'child_process';

export interface CodexConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  skipGitRepoCheck?: boolean;
  sandboxMode?: string;
  approvalPolicy?: 'never' | 'on-request';
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => void;
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
  threadId?: string;
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
    timeout = 30000,
    workingDirectory = process.cwd(),
    streamCallbacks,
    skipGitRepoCheck = true,
    sandboxMode = process.env.ACPX_CODEX_SANDBOX_MODE?.trim() || 'workspace-write',
    approvalPolicy = process.env.ACPX_CODEX_APPROVAL_POLICY === 'on-request' ? 'on-request' : 'never',
  } = config;

  try {
    console.log(`[Codex] Executing task: ${task.name}`);

    const result = await executeCodexCLI(task, {
      timeout,
      workingDirectory,
      streamCallbacks,
      skipGitRepoCheck,
      sandboxMode,
      approvalPolicy,
      onSpawn: config.onSpawn,
      onThreadStarted: config.onThreadStarted,
    });
    
    return {
      success: true,
      output: result.output,
      threadId: result.threadId ?? undefined,
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
interface CodexExecutionOptions {
  timeout: number;
  workingDirectory: string;
  streamCallbacks?: HarnessStreamCallbacks;
  skipGitRepoCheck: boolean;
  sandboxMode: string;
  approvalPolicy: 'never' | 'on-request';
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => void;
}

interface CodexCliResult {
  output: string;
  threadId: string | null;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

const executeCodexCLI = async (
  task: CodexTask,
  options: CodexExecutionOptions
): Promise<CodexCliResult> => {
  const prompt = `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

  return runCodexJsonCommand({
    args: buildExecArgs(options.skipGitRepoCheck, options.sandboxMode, options.approvalPolicy),
    prompt,
    options,
  });
};

export const resumeCodexSession = async ({
  threadId,
  prompt,
  timeout,
  workingDirectory,
  streamCallbacks,
  skipGitRepoCheck = true,
  sandboxMode = process.env.ACPX_CODEX_SANDBOX_MODE?.trim() || 'workspace-write',
  approvalPolicy = process.env.ACPX_CODEX_APPROVAL_POLICY === 'on-request' ? 'on-request' : 'never',
  onSpawn,
  onThreadStarted,
}: {
  threadId: string;
  prompt: string;
  timeout: number;
  workingDirectory: string;
  streamCallbacks?: HarnessStreamCallbacks;
  skipGitRepoCheck?: boolean;
  sandboxMode?: string;
  approvalPolicy?: 'never' | 'on-request';
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => void;
}): Promise<CodexCliResult> => {
  return runCodexJsonCommand({
    args: buildResumeArgs(threadId, skipGitRepoCheck, sandboxMode, approvalPolicy),
    prompt,
    options: {
      timeout,
      workingDirectory,
      streamCallbacks,
      skipGitRepoCheck,
      sandboxMode,
      approvalPolicy,
      onSpawn,
      onThreadStarted,
    },
  });
};

const buildExecArgs = (
  skipGitRepoCheck: boolean,
  sandboxMode: string,
  approvalPolicy: 'never' | 'on-request'
) => {
  const args = ['exec', '--json', '--sandbox', sandboxMode];
  args.push('--ask-for-approval', approvalPolicy);
  if (skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  args.push('-');
  return args;
};

const buildResumeArgs = (
  threadId: string,
  skipGitRepoCheck: boolean,
  sandboxMode: string,
  approvalPolicy: 'never' | 'on-request'
) => {
  const normalizedSandboxMode = sandboxMode.trim().toLowerCase();
  const args = ['exec', 'resume', threadId, '--json'];

  if (normalizedSandboxMode === 'workspace-write' && approvalPolicy === 'on-request') {
    args.push('--full-auto');
  } else if (normalizedSandboxMode === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  if (skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  args.push('-');
  return args;
};

const runCodexJsonCommand = async ({
  args,
  prompt,
  options,
}: {
  args: string[];
  prompt: string;
  options: CodexExecutionOptions;
}): Promise<CodexCliResult> => {
  const { spawn } = await import('child_process');

  return new Promise<CodexCliResult>((resolve, reject) => {
    let rawStdout = '';
    let resolvedText = '';
    let stderr = '';
    let settled = false;
    let threadId: string | null = null;
    let stdoutBuffer = '';

    const child = spawn('codex', args, {
      cwd: options.workingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    options.onSpawn?.(child);
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      console.log('[Codex] Timeout, killing process');
      child.kill('SIGTERM');
      reject(new Error(`Codex execution timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdin.write(prompt);
    child.stdin.end();

    console.log('[Codex] Sending prompt:', prompt.substring(0, 100) + '...');
    console.log('[Codex] Exec args:', args.join(' '));
    console.log('[Codex] Working directory:', options.workingDirectory);
    console.log('[Codex] Sandbox mode:', options.sandboxMode);
    console.log('[Codex] Approval policy:', options.approvalPolicy);

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      rawStdout += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed) as CodexJsonEvent;
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id;
            options.onThreadStarted?.(event.thread_id);
          }

          const text =
            event.type === 'item.completed'
            && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string'
              ? event.item.text
              : null;

          if (text) {
            resolvedText = text;
            void options.streamCallbacks?.onStdoutChunk?.(text);
          }
        } catch {
          void options.streamCallbacks?.onStdoutChunk?.(trimmed);
        }
      }
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
      clearTimeout(timeoutId);
      console.log('[Codex] Process exited with code:', code);
      console.log('[Codex] Stdout length:', rawStdout.length);
      console.log('[Codex] Stderr:', stderr);

      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as CodexJsonEvent;
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id;
            options.onThreadStarted?.(event.thread_id);
          }

          const text =
            event.type === 'item.completed'
            && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string'
              ? event.item.text
              : null;

          if (text) {
            resolvedText = text;
          }
        } catch {
          if (!resolvedText) {
            resolvedText = stdoutBuffer.trim();
          }
        }
      }

      if (code === 0 || resolvedText.length > 0 || rawStdout.length > 0) {
        resolve({
          output: resolvedText || rawStdout || 'Task executed successfully',
          threadId,
        });
      } else {
        reject(new Error(stderr || `Codex exited with code ${code}`));
      }
    });

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
