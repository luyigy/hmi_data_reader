/**
 * Claude Code Agent Integration
 * 
 * Executes tasks using Claude Code CLI
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { ChildProcess } from 'child_process';

export interface ClaudeConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  resumeSessionId?: string;
  onSessionStarted?: (sessionId: string) => void;
}

export interface ClaudeTask {
  id: string;
  name: string;
  description?: string;
}

export interface ClaudeResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
}

/**
 * Execute a task using Claude Code
 */
export const executeClaudeTask = async (
  task: ClaudeTask,
  config: ClaudeConfig = {}
): Promise<ClaudeResult> => {
  const startTime = Date.now();
  const {
    timeout = 60000,
    workingDirectory = process.cwd(),
    streamCallbacks,
  } = config;

  try {
    console.log(`[Claude] Executing task: ${task.name}`);

    // Execute claude code CLI
    const result = await executeClaudeCLI(task, {
      timeout,
      workingDirectory,
      streamCallbacks,
      onSpawn: config.onSpawn,
      onSessionStarted: config.onSessionStarted,
    });
    
    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
      sessionId: result.sessionId,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[Claude] Execution failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

export const resumeClaudeSession = async ({
  sessionId,
  prompt,
  timeout,
  workingDirectory = process.cwd(),
  streamCallbacks,
  onSpawn,
  onSessionStarted,
}: {
  sessionId: string;
  prompt: string;
  timeout: number;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (sessionId: string) => void;
}): Promise<ClaudeResult> => {
  const startTime = Date.now();

  try {
    const result = await executeClaudeCLI(
      {
        id: 'continuation',
        name: 'Claude continuation',
        description: prompt,
      },
      {
        timeout,
        workingDirectory,
        streamCallbacks,
        onSpawn,
        resumeSessionId: sessionId,
        onSessionStarted,
        rawPrompt: prompt,
      }
    );

    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
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

/**
 * Execute using Claude Code CLI
 */
const executeClaudeCLI = async (
  task: ClaudeTask,
  options: {
    timeout: number;
    workingDirectory: string;
    streamCallbacks?: HarnessStreamCallbacks;
    onSpawn?: (child: ChildProcess) => void;
    resumeSessionId?: string;
    onSessionStarted?: (sessionId: string) => void;
    rawPrompt?: string;
  }
): Promise<{ output: string; filesModified?: string[]; sessionId?: string }> => {
  const { spawn } = await import('child_process');
  
  const prompt = options.rawPrompt ?? `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any files you modified
3. Any issues you encountered

Take your time and be thorough.`;

  console.log('[Claude] Prompt:', prompt.substring(0, 200) + '...');

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let resolvedOutput = '';
    let sessionId: string | null = null;
    
    // Spawn claude process
    const args = options.resumeSessionId
      ? [
          '--resume',
          options.resumeSessionId,
          '--print',
          '--verbose',
          '--output-format',
          'stream-json',
          '--permission-mode',
          'bypassPermissions',
          prompt,
        ]
      : [
          '--print',
          '--verbose',
          '--output-format',
          'stream-json',
          '--permission-mode',
          'bypassPermissions',
          prompt,
        ];

    const child = spawn('claude', args, {
      cwd: options.workingDirectory,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    options.onSpawn?.(child);

    // Collect stdout
    child.stdout.on('data', (data) => {
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
          const event = JSON.parse(trimmed) as {
            type?: string;
            session_id?: string;
            message?: {
              content?: Array<{ type?: string; text?: string }>;
            };
            result?: string;
          };

          if (typeof event.session_id === 'string' && event.session_id.trim()) {
            sessionId = event.session_id.trim();
            options.onSessionStarted?.(sessionId);
          }

          if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            const text = event.message.content
              .filter((item) => item.type === 'text' && typeof item.text === 'string')
              .map((item) => item.text as string)
              .join('');

            if (text) {
              resolvedOutput = text;
              void options.streamCallbacks?.onStdoutChunk?.(text);
            }
            continue;
          }

          if (event.type === 'result' && typeof event.result === 'string') {
            resolvedOutput = event.result;
            continue;
          }
        } catch {
          void options.streamCallbacks?.onStdoutChunk?.(trimmed);
        }
      }
    });

    // Collect stderr
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      void options.streamCallbacks?.onStderrChunk?.(chunk);
    });

    // Handle completion
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as { session_id?: string; result?: string };
          if (typeof event.session_id === 'string' && event.session_id.trim()) {
            sessionId = event.session_id.trim();
            options.onSessionStarted?.(sessionId);
          }
          if (typeof event.result === 'string') {
            resolvedOutput = event.result;
          }
        } catch {
          void options.streamCallbacks?.onStdoutChunk?.(stdoutBuffer.trim());
        }
      }

      const output = resolvedOutput || stdout || stderr || 'Task executed successfully';
      
      // Try to extract modified files from output
      const filesModified = extractModifiedFiles(output);

      if (code === 0 || stdout.length > 0) {
        resolve({ output, filesModified, sessionId: sessionId || undefined });
      } else {
        reject(new Error(stderr || `Claude exited with code ${code}`));
      }
    });

    // Handle errors
    child.on('error', (err) => {
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude execution timed out after ${options.timeout}ms`));
    }, options.timeout);
  });
};

/**
 * Extract modified files from Claude's output
 */
const extractModifiedFiles = (output: string): string[] => {
  const filePattern = /(modified|created|deleted):\s*(.+)/gi;
  const files: string[] = [];
  let match;

  while ((match = filePattern.exec(output)) !== null) {
    files.push(match[2].trim());
  }

  return files;
};

/**
 * Check if Claude Code is available
 */
export const isClaudeAvailable = async (): Promise<boolean> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    await execAsync('claude --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Get Claude Code version
 */
export const getClaudeVersion = async (): Promise<string> => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync('claude --version', { timeout: 5000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};

/**
 * Initialize Claude Code configuration
 */
export const initClaudeConfig = async (): Promise<void> => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    // Check if claude is already configured
    await execAsync('claude --version', { timeout: 5000 });
    console.log('[Claude] Already configured');
  } catch {
    console.log('[Claude] Not configured. Please run: claude login');
    throw new Error('Claude Code not configured. Please run "claude login" first.');
  }
};
