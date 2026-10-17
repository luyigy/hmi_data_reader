import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';

import {
  parseAntigravityUsageFromText,
  type AntigravityContextUsage,
} from './antigravity-context';
import {
  collectAntigravityRuntimeState,
  getAntigravityExecutionLogPath,
} from './antigravity-runtime-state';
import type { HarnessRuntimeState } from '@/lib/harness/types';

export interface AntigravityConfig {
  timeout?: number | null;
  sessionId?: string;
  prompt?: string;
  // Print mode uses one prompt string; reapply this prefix on every resumed turn.
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  onSessionStarted?: (sessionId: string) => Promise<void> | void;
  workingDirectory?: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  extraReadOnlyPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  streamCallbacks?: HarnessStreamCallbacks;
  sandboxMode?: string;
  onSpawn?: (child: ChildProcess) => void;
  executionId?: string;
}

export interface AntigravityTask {
  id: string;
  name: string;
  description?: string;
}

export interface AntigravityResult {
  success: boolean;
  sessionId?: string;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  contextUsage?: AntigravityContextUsage;
  runtimeState?: HarnessRuntimeState;
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

const normalizeOutput = (value: string) => value.trim().replace(/\s+/g, ' ');

const executeAntigravityTurn = (
  task: AntigravityTask,
  config: AntigravityConfig = {}
): Promise<AntigravityResult> => {
  const startedAt = Date.now();
  const timeout = config.timeout === null ? null : (config.timeout ?? 300000);
  const executionId = config.executionId || randomUUID();
  const logFile = getAntigravityExecutionLogPath(executionId);
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    // Ignore if directory exists or cannot be created
  }
  const message = config.prompt ?? task.description ?? `Task: ${task.name}\n\nPlease complete this task.`;
  const prompt = config.systemPrompt ? `${config.systemPrompt}\n\n${message}` : message;
  const args = [
    '-p',
    prompt,
    ...resolveProjectArgs(config.workingDirectory),
    ...(config.sessionId ? [`--conversation=${config.sessionId}`] : []),
    ...(config.model ? ['--model', config.model] : []),
    ...(config.reasoningEffort ? ['--effort', config.reasoningEffort] : []),
    '--output-format',
    'stream-json',
    ...(timeout === null ? [] : [`--print-timeout=${timeout}ms`]),
    ...(logFile ? ['--log-file', logFile] : []),
    ...(config.workspaceRoot || config.sandboxMode === 'danger-full-access'
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
    sandboxMode: config.sandboxMode,
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
    let sessionId: string | undefined;
    let sessionWrite: Promise<void> = Promise.resolve();
    let sessionError: unknown;
    let initModel: string | undefined;
    let finalResult: { status?: string; response?: string; error?: unknown; denied_actions?: unknown[] } | undefined;
    const processLine = (line: string) => {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object') return;
        const id = event.event === 'init' ? event.conversation_id
          : event.event === 'result' ? event.result?.conversation_id : undefined;
        if (typeof id === 'string' && id.trim() && id !== sessionId) {
          sessionId = id;
          sessionWrite = sessionWrite.then(() => config.onSessionStarted?.(id)).catch((error) => {
            sessionError = error;
          });
        }
        if (event.event === 'init' && typeof event.init?.model === 'string' && event.init.model.trim()) {
          initModel = event.init.model.trim();
        }
        if (event.event === 'result') {
          finalResult = event.result && typeof event.result === 'object' && !Array.isArray(event.result)
            ? event.result : undefined;
        }
      } catch {
        // CLI diagnostics are not protocol events.
      }
    };
    const finish = (result: Omit<AntigravityResult, 'executionTime'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, sessionId, executionTime: Date.now() - startedAt });
    };
    const timer = timeout === null
      ? undefined
      : setTimeout(() => {
          child.kill('SIGTERM');
          finish({ success: false, error: `Antigravity execution timed out after ${timeout}ms` });
        }, timeout);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      void config.streamCallbacks?.onStdoutChunk?.(text);
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line.trim());
      }
    });
    child.stderr?.on('data', (text: string) => {
      stderr += text;
      void config.streamCallbacks?.onStderrChunk?.(text);
    });
    child.on('error', (error) => finish({
      success: false,
      error: `Failed to start Antigravity CLI: ${error.message}`,
    }));
    child.on('close', async (code) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer.trim());
      }
      await sessionWrite;
      const output = typeof finalResult?.response === 'string' ? finalResult.response.trim() : '';
      const contextUsage = parseAntigravityUsageFromText(stdout) || parseAntigravityUsageFromText(stderr) || undefined;
      if (sessionError) {
        finish({ success: false, error: `Failed to persist Antigravity session: ${String(sessionError)}`, contextUsage });
      } else if (finalResult?.denied_actions?.length) {
        finish({ success: false, error: 'Antigravity 权限请求被拒绝，本轮未完成。请检查成员权限后重试。', contextUsage });
      } else if (finalResult?.status && finalResult.status !== 'SUCCESS') {
        finish({ success: false, error: typeof finalResult.error === 'string' ? finalResult.error
          : output || stderr.trim() || `Antigravity result: ${finalResult.status}`, contextUsage });
      } else if (code !== 0) {
        finish({ success: false, error: stderr.trim() || output || `Antigravity exited with code ${code}`, contextUsage });
      } else if (!finalResult && stdout.trim()) {
        finish({ success: false, error: 'Antigravity exited without a result event', contextUsage });
      } else if (!output) {
        finish({
          success: false,
          error: `Antigravity returned no final output${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          contextUsage,
        });
      } else if (normalizeOutput(output) === normalizeOutput(prompt)) {
        finish({ success: false, error: `Antigravity returned only the input prompt${stderr.trim() ? `: ${stderr.trim()}` : ''}`, contextUsage });
      } else {
        const runtimeState = sessionId ? await collectAntigravityRuntimeState({
          executionId,
          sessionId,
          logFile,
          initModel,
          startedAt,
          completedAt: Date.now(),
        }) : undefined;
        finish({ success: true, output, filesModified: [], contextUsage, runtimeState });
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

// Print mode has no in-flight stdin steering: cancel the turn, then resume its
// persisted conversation. Never run two CLI processes against that conversation.
export const executeAntigravityTask = async (
  task: AntigravityTask, config: AntigravityConfig = {},
): Promise<AntigravityResult> => {
  if (!config.streamCallbacks?.onSteeringReady) return executeAntigravityTurn(task, config);
  const startedAt = Date.now();
  let sessionId = config.sessionId;
  let prompt = config.prompt;
  let interrupt: (() => boolean) | undefined;
  let stopped = false;
  let pending: string[] = [];
  let unregister: (() => void) | undefined;
  const seen = new Set<string>();
  try {
    while (true) {
      const result = await executeAntigravityTurn(task, {
        ...config, sessionId, prompt,
        timeout: config.timeout === null ? null : Math.max(1, (config.timeout ?? 300000) - (Date.now() - startedAt)),
        onSpawn: (child) => {
          const kill = child.kill.bind(child);
          interrupt = () => child.exitCode === null && child.signalCode === null && kill('SIGINT');
          // Explicit stop/reset from the platform must also cancel a pending resume.
          child.kill = (signal) => { stopped = true; return kill(signal); };
          config.onSpawn?.(child);
        },
        onSessionStarted: async (id) => {
          await config.onSessionStarted?.(id);
          sessionId = id;
          unregister ??= config.streamCallbacks!.onSteeringReady!(async (messageId, message) => {
            if (stopped || !interrupt) return 'rejected';
            if (seen.has(messageId)) return 'accepted';
            if (!pending.length && !interrupt()) return 'rejected';
            pending.push(message);
            seen.add(messageId);
            return 'accepted';
          });
        },
      });
      interrupt = undefined;
      if (stopped || !pending.length || !sessionId || (config.timeout !== null && Date.now() - startedAt >= (config.timeout ?? 300000))) {
        return { ...result, executionTime: Date.now() - startedAt };
      }
      prompt = `The user interrupted the previous turn. Follow the latest instructions below, preserving relevant conversation context. Do not finish an obsolete instruction first.\n\n${pending.join('\n\n')}`;
      pending = [];
    }
  } finally {
    unregister?.();
  }
};
