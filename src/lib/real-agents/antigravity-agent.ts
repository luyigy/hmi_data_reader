import { spawn, type ChildProcess } from 'child_process';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';

export interface AntigravityConfig {
  timeout?: number | null;
  workingDirectory?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  sandboxMode?: string;
  onSpawn?: (child: ChildProcess) => void;
}

export interface AntigravityTask {
  id: string;
  name: string;
  description?: string;
}

export interface AntigravityResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
}

const AGY_BIN = process.env.ANTIGRAVITY_CLI_PATH?.trim() || 'agy';

const childEnv = () => {
  const env = { ...process.env };
  const httpProxy = env.HTTP_PROXY || env.http_proxy || env.FEISHU_RUNTIME_CODEX_HTTP_PROXY;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || env.FEISHU_RUNTIME_CODEX_HTTPS_PROXY;
  const allProxy = env.ALL_PROXY || env.all_proxy || env.FEISHU_RUNTIME_CODEX_ALL_PROXY;
  const noProxy = env.NO_PROXY || env.no_proxy || env.FEISHU_RUNTIME_CODEX_NO_PROXY;
  if (httpProxy) env.HTTP_PROXY = env.http_proxy = httpProxy;
  if (httpsProxy) env.HTTPS_PROXY = env.https_proxy = httpsProxy;
  if (allProxy) env.ALL_PROXY = env.all_proxy = allProxy;
  if (noProxy) env.NO_PROXY = env.no_proxy = noProxy;
  const localBin = `${env.HOME || '/home/hello'}/.local/bin`;
  if (!env.PATH?.split(':').includes(localBin)) {
    env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;
  }
  return env;
};

const promptFor = (task: AntigravityTask) =>
  `Task: ${task.name}\n\n${task.description || 'Please complete this task.'}`;

const normalizeOutput = (value: string) => value.trim().replace(/\s+/g, ' ');

export const executeAntigravityTask = (
  task: AntigravityTask,
  config: AntigravityConfig = {}
): Promise<AntigravityResult> => {
  const startedAt = Date.now();
  const timeout = config.timeout === null ? null : (config.timeout ?? 300000);
  const prompt = promptFor(task);
  const args = [
    '-p',
    prompt,
    ...(config.sandboxMode === 'danger-full-access'
      ? ['--dangerously-skip-permissions']
      : ['--sandbox']),
  ];

  return new Promise((resolve) => {
    const child = spawn(AGY_BIN, args, {
      cwd: config.workingDirectory || process.cwd(),
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    config.onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: Omit<AntigravityResult, 'executionTime'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, executionTime: Date.now() - startedAt });
    };
    const timer = timeout === null
      ? undefined
      : setTimeout(() => {
          child.kill('SIGTERM');
          finish({ success: false, error: `Antigravity execution timed out after ${timeout}ms` });
        }, timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      void config.streamCallbacks?.onStdoutChunk?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      void config.streamCallbacks?.onStderrChunk?.(text);
    });
    child.on('error', (error) => finish({
      success: false,
      error: `Failed to start Antigravity CLI: ${error.message}`,
    }));
    child.on('close', (code) => {
      const output = stdout.trim();
      if (code !== 0) {
        finish({ success: false, error: stderr.trim() || output || `Antigravity exited with code ${code}` });
      } else if (!output) {
        finish({
          success: false,
          error: `Antigravity returned no final output${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        });
      } else if (normalizeOutput(output) === normalizeOutput(prompt)) {
        finish({ success: false, error: `Antigravity returned only the input prompt${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
      } else {
        finish({ success: true, output, filesModified: [] });
      }
    });
  });
};

const readVersion = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = spawn(AGY_BIN, ['--version'], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? output.trim() || undefined : undefined));
  });

export const getAntigravityVersion = readVersion;
export const isAntigravityAvailable = async () => Boolean(await readVersion());
