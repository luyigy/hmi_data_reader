/**
 * Claude Code Agent Integration
 * 
 * Executes tasks using Claude Code CLI
 */

export interface ClaudeConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
  workingDirectory?: string;
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
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = 'claude-sonnet-4-20250514',
    timeout = 60000,
    workingDirectory = process.cwd(),
  } = config;

  try {
    console.log(`[Claude] Executing task: ${task.name}`);

    // Execute claude code CLI
    const result = await executeClaudeCLI(task, { timeout, workingDirectory });
    
    return {
      success: true,
      output: result.output,
      filesModified: result.filesModified,
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

/**
 * Execute using Claude Code CLI
 */
const executeClaudeCLI = async (
  task: ClaudeTask,
  options: { timeout: number; workingDirectory: string }
): Promise<{ output: string; filesModified?: string[] }> => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  // Create prompt for Claude
  const prompt = `Task: ${task.name}\n${task.description ? `Description: ${task.description}` : ''}\n\nPlease complete this task. Provide a summary of what you did at the end.`;

  try {
    // Execute claude code with the task
    // Using --print flag to get output and --permission-mode bypassPermissions for automation
    const { stdout, stderr } = await execAsync(
      `claude "${escapeShell(prompt)}" --print --permission-mode bypassPermissions`,
      {
        timeout: options.timeout,
        cwd: options.workingDirectory,
        env: { ...process.env },
      }
    );

    const output = stdout || stderr || 'Task executed successfully';
    
    // Try to extract modified files from output
    const filesModified = extractModifiedFiles(output);

    return {
      output,
      filesModified,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      // Handle timeout
      if ((error as any).code === 'ETIMEDOUT') {
        throw new Error(`Claude execution timed out after ${options.timeout}ms`);
      }
    }
    throw error;
  }
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
 * Escape shell special characters
 */
const escapeShell = (str: string): string => {
  return str.replace(/['"\\$`]/g, '\\$&');
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
