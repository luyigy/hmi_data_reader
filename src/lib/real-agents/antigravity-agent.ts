import { spawn, type ChildProcess } from 'child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { sanitizePreview } from '@/lib/acpx/harness-events';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';

import {
  parseAntigravityUsageFromText,
  type AntigravityContextUsage,
} from './antigravity-context';

export interface AntigravityConfig {
  timeout?: number | null;
  workingDirectory?: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  extraReadOnlyPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
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

const processAntigravityJsonLine = (
  line: string,
  workingDirectory: string,
  streamCallbacks?: HarnessStreamCallbacks,
) => {
  try {
    const event = JSON.parse(line) as { event?: string; step_update?: Record<string, unknown> };
    if (event.event !== 'step_update' || !event.step_update) return;
    const step = event.step_update;
    const stepType = typeof step.step_type === 'string' ? step.step_type : '';
    if (typeof step.text_delta === 'string') {
      void streamCallbacks?.onStdoutChunk?.(
        sanitizePreview(step.text_delta, { workspaceRoot: workingDirectory })
      );
      return;
    }

    const normalizedType = stepType.toLowerCase();
    if (/tool|function/.test(normalizedType)) {
      if (/result|response|output/.test(normalizedType)) {
        void streamCallbacks?.onToolEvent?.({ toolName: 'Tool Result', preview: '', emoji: '✅' });
        return;
      }
      const tool = step.tool as Record<string, unknown> | undefined;
      const fn = (step.function_call ?? step.function) as Record<string, unknown> | undefined;
      const toolCall = step.tool_call as Record<string, unknown> | undefined;
      const toolName = [step.tool_name, step.function_name, step.name, tool?.name, fn?.name, toolCall?.name]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        ?.trim() || 'Task';
      const input = step.input ?? step.args ?? step.arguments ?? step.tool_input
        ?? fn?.arguments ?? toolCall?.arguments ?? tool?.input;
      void streamCallbacks?.onToolEvent?.({
        toolName,
        preview: sanitizePreview(buildToolPreview(input) || input || '', { workspaceRoot: workingDirectory }),
        emoji: getToolEmoji(toolName),
      });
      return;
    }

    if (/thinking|reasoning|plan/.test(normalizedType)) {
      void streamCallbacks?.onStdoutChunk?.('思考中');
    } else if (stepType && !['user_input', 'agent_response'].includes(normalizedType)) {
      void streamCallbacks?.onStdoutChunk?.(
        sanitizePreview(`进度：${stepType}`, { workspaceRoot: workingDirectory })
      );
    }
  } catch {
    // Ignore non-JSON diagnostic lines; the final response extractor retains them.
  }
};

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
      : []),
  ];
  const env = childEnv();
  const wrapped = wrapWithBubblewrap({
    command: AGY_BIN,
    commandArgs: args,
    cwd: config.workingDirectory || process.cwd(),
    workspaceRoot: config.workspaceRoot,
    writableRoots: config.extraWritableRoots,
    networkAccess: config.networkAccess,
    env,
    configPaths: [path.join(env.HOME || '/home/hello', '.gemini')],
    readOnlyPaths: config.extraReadOnlyPaths?.length ? config.extraReadOnlyPaths : undefined,
  });

  return new Promise((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: config.workingDirectory || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    config.onSpawn?.(child);

    let stdout = '';
    let stdoutBuffer = '';
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
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processAntigravityJsonLine(
          line.trim(),
          config.workingDirectory || process.cwd(),
          config.streamCallbacks,
        );
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
      if (stdoutBuffer.trim()) {
        processAntigravityJsonLine(
          stdoutBuffer.trim(),
          config.workingDirectory || process.cwd(),
          config.streamCallbacks,
        );
      }
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
