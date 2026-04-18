/**
 * Claude Code Agent Integration
 * 
 * Executes tasks using Claude Code CLI
 */

import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { getToolEmoji, buildToolPreview } from '@/lib/acpx/tool-emojis';
import type { ChildProcess } from 'child_process';

export interface ClaudeConfig {
  apiKey?: string;
  model?: string;
  timeout?: number | null;
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
    timeout = null,
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
  timeout: number | null;
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
    timeout: number | null;
    workingDirectory: string;
    streamCallbacks?: HarnessStreamCallbacks;
    onSpawn?: (child: ChildProcess) => void;
    resumeSessionId?: string;
    onSessionStarted?: (sessionId: string) => void;
    rawPrompt?: string;
  }
): Promise<{ output: string; filesModified?: string[]; sessionId?: string }> => {
  const { spawn } = await import('child_process');

  const buildClaudeChildEnv = () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;

    // Ensure nvm-managed node/claude binaries are findable even when
    // the parent process was started without a full login shell PATH.
    // Include ALL nvm node version bin dirs so claude is found regardless
    // of which node version the app itself is running under.
    const nvmDir = process.env.NVM_DIR || `${process.env.HOME}/.nvm`;
    const nvmVersionsDir = `${nvmDir}/versions/node`;
    let nvmBinPaths: string[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readdirSync } = require('fs') as typeof import('fs');
      nvmBinPaths = readdirSync(nvmVersionsDir).map((v) => `${nvmVersionsDir}/${v}/bin`);
    } catch {
      // fallback to current node version only
      nvmBinPaths = [`${nvmVersionsDir}/${process.version}/bin`];
    }
    const extraPaths = [...nvmBinPaths, `${process.env.HOME}/.local/bin`].join(':');
    env.PATH = env.PATH ? `${extraPaths}:${env.PATH}` : extraPaths;
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

    return env;
  };

  const extractClaudeStructuredError = (event: {
    subtype?: string;
    is_error?: boolean;
    errors?: unknown;
    result?: string;
  }): string | null => {
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    if (event.subtype === 'error_during_execution' || event.is_error === true || errors.length > 0) {
      return errors.join('\n') || event.result || 'Claude execution failed';
    }

    return null;
  };
  
  const prompt = options.rawPrompt ?? `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any files you modified
3. Any issues you encountered

Take your time and be thorough.`;

  console.log('[Claude] Prompt:', prompt.substring(0, 200) + '...');
  if (process.env.DEBUG_MENTION_DETECTION === 'true') {
    console.log('[Claude] Full prompt (first 500 chars):', prompt.substring(0, 500));
    console.log('[Claude] Has resume session:', !!options.resumeSessionId);
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let resolvedOutput = '';
    let structuredError: string | null = null;
    let sessionId: string | null = null;
    let settled = false;
    
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

    // On Windows, need to use shell: true to find .cmd files
    // On Unix/Linux, use shell: false for better security and performance
    const shell = process.platform === 'win32';
    const child = spawn('claude', args, {
      cwd: options.workingDirectory,
      env: buildClaudeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
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
            subtype?: string;
            is_error?: boolean;
            errors?: unknown;
            session_id?: string;
            apiKeySource?: string;
            model?: string;
            permissionMode?: string;
            message?: {
              content?: Array<{ type?: string; text?: string }>;
            };
            result?: string;
          };

          if (event.type === 'system' && event.subtype === 'init') {
            console.log('[Claude] Init event:', {
              sessionId: event.session_id || null,
              apiKeySource: event.apiKeySource || null,
              model: event.model || null,
              permissionMode: event.permissionMode || null,
            });
          }

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

            for (const item of event.message.content) {
              if ((item as { type?: string }).type === 'tool_use') {
                const toolItem = item as { type: string; name?: string; input?: unknown };
                const toolName = toolItem.name || 'unknown';
                const preview = buildToolPreview(toolItem.input);
                const emoji = getToolEmoji(toolName);
                console.log(`[Claude] tool_use detected: ${toolName} | preview="${preview}" | hasCallback=${!!options.streamCallbacks?.onToolEvent}`);
                void options.streamCallbacks?.onToolEvent?.({ toolName, preview, emoji });
              }
            }

            continue;
          }

          if (event.type === 'result') {
            structuredError = extractClaudeStructuredError(event);
            if (typeof event.result === 'string') {
              resolvedOutput = event.result;
            }
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
      if (settled) {
        return;
      }
      settled = true;

      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as {
            type?: string;
            session_id?: string;
            result?: string;
            subtype?: string;
            is_error?: boolean;
            errors?: unknown;
          };
          if (typeof event.session_id === 'string' && event.session_id.trim()) {
            sessionId = event.session_id.trim();
            options.onSessionStarted?.(sessionId);
          }
          if (event.type === 'result') {
            structuredError = structuredError || extractClaudeStructuredError(event);
          }
          if (typeof event.result === 'string') {
            resolvedOutput = event.result;
          }
        } catch {
          void options.streamCallbacks?.onStdoutChunk?.(stdoutBuffer.trim());
        }
      }

      const output = resolvedOutput || stdout || stderr || 'Task executed successfully';

      if (structuredError) {
        reject(new Error(structuredError));
        return;
      }

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
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });

    // Handle timeout (null = no timeout)
    if (options.timeout !== null) {
      setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Claude execution timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
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
    const shellPath = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

    // On Windows, use shell option to ensure .cmd files are found
    await execAsync('claude --version', {
      timeout: 5000,
      shell: shellPath,
    });
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
    const shellPath = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

    const { stdout } = await execAsync('claude --version', {
      timeout: 5000,
      shell: shellPath,
    });
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
  const shellPath = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

  try {
    // Check if claude is already configured
    await execAsync('claude --version', {
      timeout: 5000,
      shell: shellPath,
    });
    console.log('[Claude] Already configured');
  } catch {
    console.log('[Claude] Not configured. Please run: claude login');
    throw new Error('Claude Code not configured. Please run "claude login" first.');
  }
};
