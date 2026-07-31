import { spawn, type ChildProcess } from 'child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';

import {
  parseAntigravityUsageFromText,
  type AntigravityContextUsage,
} from './antigravity-context';

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
  contextUsage?: AntigravityContextUsage;
}

const AGY_BIN = process.env.ANTIGRAVITY_CLI_PATH?.trim() || 'agy';

const resolveProjectArgs = (workingDirectory?: string) => {
  if (!workingDirectory) return [];

  const workspace = realpathSync(workingDirectory);
  const projectsDir = path.join(process.env.HOME || '/home/hello', '.gemini/config/projects');
  try {
    for (const filename of readdirSync(projectsDir)) {
      if (!filename.endsWith('.json')) continue;
      try {
        const project = JSON.parse(readFileSync(path.join(projectsDir, filename), 'utf8'));
        if (typeof project.id === 'string' && project.projectResources?.resources?.some(
          (resource: { folderUri?: string }) => resource.folderUri
            && realpathSync(fileURLToPath(resource.folderUri)) === workspace
        )) return [`--project=${project.id}`];
      } catch {
        continue;
      }
    }
  } catch {
    // Missing or stale Antigravity project metadata is repaired by the CLI below.
  }

  // ponytail: simultaneous first runs may create duplicates; add a per-workspace lock only if observed.
  return ['--new-project'];
};

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

const extractAntigravityResponse = (stdout: string): string => {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.event === 'result' && typeof obj.result?.response === 'string') {
          return obj.result.response.trim();
        }
      } catch {
        // continue
      }
    }
  }

  let text = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.event === 'step_update' && typeof obj.step_update?.text_delta === 'string') {
          text += obj.step_update.text_delta;
        }
      } catch {
        // continue
      }
    }
  }

  return text.trim() || stdout.trim();
};

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
    ...resolveProjectArgs(config.workingDirectory),
    '--output-format',
    'stream-json',
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
      // Extract text_delta from stream-json lines if possible
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            const obj = JSON.parse(trimmed);
            if (obj.event === 'step_update' && typeof obj.step_update?.text_delta === 'string') {
              void config.streamCallbacks?.onStdoutChunk?.(obj.step_update.text_delta);
              continue;
            }
          } catch {
            // continue
          }
        }
      }
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
      const output = extractAntigravityResponse(stdout);
      const contextUsage = parseAntigravityUsageFromText(stdout) || parseAntigravityUsageFromText(stderr) || undefined;
      if (code !== 0) {
        finish({ success: false, error: stderr.trim() || output || `Antigravity exited with code ${code}`, contextUsage });
      } else if (!output) {
        finish({
          success: false,
          error: `Antigravity returned no final output${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          contextUsage,
        });
      } else if (normalizeOutput(output) === normalizeOutput(prompt)) {
        finish({ success: false, error: `Antigravity returned only the input prompt${stderr.trim() ? `: ${stderr.trim()}` : ''}`, contextUsage });
      } else {
        finish({ success: true, output, filesModified: [], contextUsage });
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
