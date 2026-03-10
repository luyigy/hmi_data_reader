/**
 * Codex Agent Integration
 * 
 * Executes tasks using OpenAI Codex via CLI
 */

export interface CodexConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
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
  } = config;

  try {
    console.log(`[Codex] Executing task: ${task.name}`);

    // Method 1: Using codex CLI directly
    const result = await executeCodexCLI(task, timeout);
    
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
 * Execute using codex CLI
 */
const executeCodexCLI = async (
  task: CodexTask,
  timeout: number
): Promise<string> => {
  const { spawn } = await import('child_process');
  
  // Create prompt for Codex
  const prompt = `Task: ${task.name}\nDescription: ${task.description || 'No description'}\n\nPlease complete this task:`;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    
    // Spawn codex process
    const child = spawn('codex', [], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true, // Windows 需要这个来找到命令
    });

    // Send prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();
    
    console.log('[Codex] Sending prompt:', prompt);

    // Collect stdout
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle completion
    child.on('close', (code) => {
      if (code === 0 || stdout.length > 0) {
        resolve(stdout || 'Task executed successfully');
      } else {
        reject(new Error(stderr || `Codex exited with code ${code}`));
      }
    });

    // Handle errors
    child.on('error', (err) => {
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Codex execution timed out after ${timeout}ms`));
    }, timeout);
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
