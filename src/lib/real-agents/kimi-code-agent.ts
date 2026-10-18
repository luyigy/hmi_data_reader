import { existsSync, realpathSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { sanitizePreview } from '@/lib/acpx/harness-events';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';
import { redactSensitiveText } from '@/lib/redact-sensitive';

export const KIMI_CODE_MAX_SUBAGENTS = 3;

const redactKimiOutput = (value: string) => redactSensitiveText(value)
  .replace(/\bsk-[A-Za-z0-9_-]{6,}/gi, '[REDACTED]')
  .replace(/(\bbearer\s+)[^\s,;"'}]+/gi, '$1[REDACTED]');

export interface KimiCodeConfig {
  timeout?: number | null;
  workingDirectory?: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  extraReadOnlyPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  sandboxMode?: string;
  permissionProfile?: string;
  runtimeHome?: string;
  taskEnvironment?: Record<string, string>;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  model?: string;
  prompt?: string;
  sessionId?: string;
}

export interface KimiCodeTask {
  id: string;
  name: string;
  description?: string;
}

export interface KimiCodeResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
}

const getKimiCodeBinary = () => process.env.KIMI_CODE_CLI_PATH?.trim() || 'kimi';
export const getKimiCodeHome = () =>
  process.env.KIMI_CODE_HOME?.trim() || path.join(homedir(), '.kimi-code');

const proxyVariables = [
  ['HTTP_PROXY', 'http_proxy', 'FEISHU_RUNTIME_CODEX_HTTP_PROXY'],
  ['HTTPS_PROXY', 'https_proxy', 'FEISHU_RUNTIME_CODEX_HTTPS_PROXY'],
  ['ALL_PROXY', 'all_proxy', 'FEISHU_RUNTIME_CODEX_ALL_PROXY'],
  ['NO_PROXY', 'no_proxy', 'FEISHU_RUNTIME_CODEX_NO_PROXY'],
] as const;

export function buildKimiCodeChildEnv() {
  const env = { ...process.env };
  for (const [upper, lower, fallback] of proxyVariables) {
    const value = env[upper]?.trim() || env[lower]?.trim() || process.env[fallback]?.trim();
    if (value) {
      env[upper] = value;
      env[lower] = value;
    }
  }
  return env;
}

const buildPrompt = (task: KimiCodeTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a summary of:
1. What you did
2. Any findings or results
3. Any issues you encountered

Take your time and be thorough.`;

const processKimiCodeJsonLine = (
  line: string,
  state: {
    output: string;
    structuredError?: string;
    sessionId?: string;
    thinkingNotified?: boolean;
    subagentCount: number;
    subagentCalls: Map<string, { taskId: string; description: string }>;
    subagentLimitExceeded?: boolean;
  },
  workspaceRoot: string,
  streamCallbacks?: HarnessStreamCallbacks
) => {
  let event: {
    role?: string;
    type?: string;
    content?: string;
    error?: string;
    message?: string;
    session_id?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    // Anthropic-style streaming fields
    name?: string;
    input?: unknown;
    content_block?: {
      type?: string;
      name?: string;
      input?: unknown;
    };
    delta?: string | {
      type?: string;
      text?: string;
      thinking?: string;
    };
    info?: {
      taskId?: string;
      description?: string;
      status?: string;
      kind?: string;
      agentId?: string;
      subagentType?: string;
      model?: string;
      startedAt?: number;
      endedAt?: number;
    };
    outputTail?: string | null;
    tool_call_id?: string;
  };

  try {
    event = JSON.parse(line);
  } catch {
    state.structuredError = `Invalid Kimi Code stream-json output: ${line}`;
    return;
  }

  const thinking = event.type === 'thinking'
    || event.type === 'redacted_thinking'
    || event.content_block?.type === 'thinking'
    || event.content_block?.type === 'redacted_thinking'
    || (typeof event.delta === 'object'
      && ['thinking_delta', 'redacted_thinking'].includes(event.delta.type ?? ''));
  if (thinking && !state.thinkingNotified) {
    state.thinkingNotified = true;
    void streamCallbacks?.onStdoutChunk?.('思考中');
  }

  const isDelta = event.type === 'content_block_delta' || event.type === 'delta';
  const deltaText = !thinking && isDelta
    ? (typeof event.delta === 'string' ? event.delta : event.delta?.text)
    : undefined;
  const assistantText = deltaText
    ?? (!isDelta && event.role === 'assistant' && typeof event.content === 'string'
      ? event.content
      : undefined);
  if (assistantText) {
    state.output += assistantText;
    void streamCallbacks?.onStdoutChunk?.(sanitizePreview(assistantText, { workspaceRoot }));
  }

  if (
    (event.type === 'task.started' || event.type === 'task.terminated')
    && event.info?.kind === 'agent'
    && event.info.taskId
  ) {
    const description = sanitizePreview(event.info.description || event.info.taskId, { workspaceRoot });
    void streamCallbacks?.onSubagentEvent?.({
      taskId: event.info.taskId,
      agentId: event.info.agentId,
      description,
      status: event.info.status || (event.type === 'task.started' ? 'running' : 'unknown'),
      subagentType: event.info.subagentType,
      model: event.info.model,
      startedAt: event.info.startedAt,
      endedAt: event.info.endedAt,
      output: typeof event.outputTail === 'string' ? redactKimiOutput(event.outputTail) : undefined,
    });
  }
  if (event.role === 'assistant' && Array.isArray(event.tool_calls)) {
    for (const toolCall of event.tool_calls) {
      const toolName = toolCall.function?.name?.trim() || 'Task';
      const rawArguments = toolCall.function?.arguments;
      let input: unknown = rawArguments;
      if (rawArguments) {
        try {
          input = JSON.parse(rawArguments);
        } catch {
          // Keep malformed or non-JSON arguments as the best available preview.
        }
      }
      if (toolName === 'Agent' || toolName === 'AgentSwarm') {
        const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const requested = toolName === 'AgentSwarm'
          ? (Array.isArray(args.items) ? args.items.length : 0)
            + (args.resume_agent_ids && typeof args.resume_agent_ids === 'object'
              ? Object.keys(args.resume_agent_ids).length
              : 0)
          : 1;
        if (state.subagentCount + requested > KIMI_CODE_MAX_SUBAGENTS) {
          state.subagentLimitExceeded = true;
          state.structuredError = `Kimi Code exceeded the platform limit of ${KIMI_CODE_MAX_SUBAGENTS} SubAgents.`;
        } else {
          state.subagentCount += requested;
          const callId = toolCall.id || `${toolName}-${state.subagentCount}`;
          const description = sanitizePreview(
            typeof args.description === 'string' ? args.description : toolName,
            { workspaceRoot },
          );
          state.subagentCalls.set(callId, { taskId: callId, description });
          for (let index = 0; index < requested; index += 1) {
            void streamCallbacks?.onSubagentEvent?.({
              taskId: requested === 1 ? callId : `${callId}:${index + 1}`,
              description,
              status: 'running',
              ordinal: state.subagentCount - requested + index + 1,
              limit: KIMI_CODE_MAX_SUBAGENTS,
              subagentType: typeof args.subagent_type === 'string' ? args.subagent_type : undefined,
              model: typeof args.model === 'string' ? args.model : undefined,
            });
          }
        }
      }
      void streamCallbacks?.onToolEvent?.({
        toolName,
        preview: sanitizePreview(buildToolPreview(input) || rawArguments?.trim() || '', { workspaceRoot }),
        emoji: getToolEmoji(toolName),
      });
    }
  }

  if (event.role === 'tool' && event.tool_call_id && state.subagentCalls.has(event.tool_call_id)) {
    const call = state.subagentCalls.get(event.tool_call_id)!;
    const output = typeof event.content === 'string' ? redactKimiOutput(event.content) : undefined;
    const status = /\bstatus:\s*running\b/i.test(output || '')
      ? 'running'
      : /\bstatus:\s*(?:failed|killed|lost)\b/i.test(output || '')
      ? 'failed'
      : 'completed';
    void streamCallbacks?.onSubagentEvent?.({ ...call, status, output });
    if (status !== 'running') state.subagentCalls.delete(event.tool_call_id);
  }

  // Also detect tool_use events (Anthropic-style streaming format)
  if (event.type === 'tool_use' && typeof event.name === 'string') {
    void streamCallbacks?.onToolEvent?.({
      toolName: event.name,
      preview: sanitizePreview(buildToolPreview(event.input) || event.input || '', { workspaceRoot }),
      emoji: getToolEmoji(event.name),
    });
  }

  // Detect content_block_start with tool_use (alternative format)
  if (
    event.type === 'content_block_start'
    && event.content_block?.type === 'tool_use'
    && typeof event.content_block?.name === 'string'
  ) {
    void streamCallbacks?.onToolEvent?.({
      toolName: event.content_block.name,
      preview: sanitizePreview(
        buildToolPreview(event.content_block.input) || event.content_block.input || '',
        { workspaceRoot }
      ),
      emoji: getToolEmoji(event.content_block.name),
    });
  }

  if (
    event.type === 'tool_result'
    || event.role === 'tool'
    || (event.type === 'content_block_start' && event.content_block?.type === 'tool_result')
  ) {
    void streamCallbacks?.onToolEvent?.({ toolName: 'Tool Result', preview: '', emoji: '✅' });
  }

  if (
    event.role === 'meta'
    && event.type === 'session.resume_hint'
    && typeof event.session_id === 'string'
    && event.session_id.trim()
  ) {
    state.sessionId = event.session_id.trim();
  }

  if (
    typeof event.error === 'string'
    || ((event.type === 'error' || event.role === 'error') && typeof event.message === 'string')
  ) {
    state.structuredError =
      typeof event.error === 'string' ? event.error : event.message;
  }
};

const runKimiCodeCommand = async ({
  prompt,
  timeout,
  workingDirectory,
  workspaceRoot,
  extraWritableRoots,
  extraReadOnlyPaths,
  networkAccess,
  sandboxMode,
  permissionProfile,
  runtimeHome,
  taskEnvironment,
  streamCallbacks,
  onSpawn,
  model,
  sessionId,
}: {
  prompt: string;
  timeout: number | null;
  workingDirectory: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  extraReadOnlyPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  sandboxMode?: string;
  permissionProfile?: string;
  runtimeHome?: string;
  taskEnvironment?: Record<string, string>;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  model?: string;
  sessionId?: string;
}): Promise<{ output: string; sessionId?: string }> => {
  if (!workspaceRoot && permissionProfile !== 'full_access') {
    throw new Error('Kimi Code requires Bubblewrap unless full access is explicitly selected.');
  }

  const env = { ...buildKimiCodeChildEnv(), ...taskEnvironment };
  if (runtimeHome) { env.AP_TASK_SANDBOX = '1'; env.AP_SANDBOX_MODEL_ACCESS = '1'; env.XDG_CACHE_HOME = taskEnvironment?.XDG_CACHE_HOME || '/tmp/cache'; env.NPM_CONFIG_CACHE = taskEnvironment?.NPM_CONFIG_CACHE || '/tmp/npm'; env.PYTHONPYCACHEPREFIX = taskEnvironment?.PYTHONPYCACHEPREFIX || '/tmp/python'; env.HOME = runtimeHome; env.KIMI_CODE_HOME = path.join(runtimeHome, '.kimi-code'); }
  const activeHome = runtimeHome ? path.join(runtimeHome, '.kimi-code') : getKimiCodeHome();
  env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY = String(KIMI_CODE_MAX_SUBAGENTS);
  // Prompt mode is implicitly Kimi's fully autonomous `auto` mode; Bubblewrap is the safety boundary.
  const args = [
    '--prompt',
    `${prompt}\n\nPlatform constraint: create at most ${KIMI_CODE_MAX_SUBAGENTS} SubAgents in total during this run, including Agent and AgentSwarm calls.`,
    '--output-format',
    'stream-json',
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--session', sessionId);

  const wrapped = wrapWithBubblewrap({
    command: getKimiCodeBinary(),
    commandArgs: args,
    cwd: workingDirectory,
    workspaceRoot,
    writableRoots: extraWritableRoots,
    networkAccess,
    sandboxMode,
    env,
    configPaths: [runtimeHome || activeHome, ...(runtimeHome ? ['credentials', 'oauth'].map((name) => path.join(activeHome, name)).filter(existsSync).map((entry) => realpathSync(entry)) : [])],
    readOnlyPaths: extraReadOnlyPaths?.length ? extraReadOnlyPaths : undefined,
  });
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: workingDirectory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onSpawn?.(child);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let closed = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;
    const state = {
      output: '',
      subagentCount: 0,
      subagentCalls: new Map<string, { taskId: string; description: string }>(),
    } as {
      output: string;
      structuredError?: string;
      sessionId?: string;
      subagentCount: number;
      subagentCalls: Map<string, { taskId: string; description: string }>;
      subagentLimitExceeded?: boolean;
    };

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    if (typeof timeout === 'number' && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        forceKillHandle = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 2000);
        forceKillHandle.unref();
        if (!settled) {
          settled = true;
          reject(new Error(`Kimi Code execution timed out after ${timeout}ms`));
        }
      }, timeout);
    }

    child.stdout.on('data', (data) => {
      if (settled) return;
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          processKimiCodeJsonLine(line.trim(), state, workspaceRoot || workingDirectory, streamCallbacks);
          if (state.subagentLimitExceeded) {
            child.kill('SIGTERM');
            fail(state.structuredError!);
            return;
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (settled) return;
      const chunk = data.toString();
      stderr += chunk;
      void streamCallbacks?.onStderrChunk?.(chunk);
    });

    child.on('error', (error) => fail(`Failed to start Kimi Code CLI: ${error.message}`));
    child.on('close', (code) => {
      closed = true;
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (settled) return;
      if (stdoutBuffer.trim()) {
        processKimiCodeJsonLine(
          stdoutBuffer.trim(),
          state,
          workspaceRoot || workingDirectory,
          streamCallbacks
        );
      }
      cleanup();
      if (code === 0 && !state.structuredError) {
        settled = true;
        resolve({
          output: state.output || 'Kimi Code completed',
          sessionId: state.sessionId,
        });
        return;
      }
      fail(
        state.structuredError
        || stderr.trim()
        || stdout.trim()
        || `Kimi Code exited with code ${code ?? 'unknown'}`
      );
    });
  });
};

export const executeKimiCodeTask = async (
  task: KimiCodeTask,
  config: KimiCodeConfig = {}
): Promise<KimiCodeResult> => {
  const startTime = Date.now();
  try {
    const result = await runKimiCodeCommand({
      prompt: config.prompt ?? buildPrompt(task),
      timeout: config.timeout === undefined ? 300000 : config.timeout,
      workingDirectory: config.workingDirectory || process.cwd(),
      workspaceRoot: config.workspaceRoot,
      extraWritableRoots: config.extraWritableRoots,
      extraReadOnlyPaths: config.extraReadOnlyPaths,
      networkAccess: config.networkAccess,
      permissionProfile: config.permissionProfile,
      sandboxMode: config.sandboxMode,
      runtimeHome: config.runtimeHome,
      taskEnvironment: config.taskEnvironment,
      streamCallbacks: config.streamCallbacks,
      onSpawn: config.onSpawn,
      model: config.model,
      sessionId: config.sessionId,
    });
    return {
      success: true,
      output: result.output,
      sessionId: result.sessionId,
      executionTime: Date.now() - startTime,
      filesModified: [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: Date.now() - startTime,
    };
  }
};

export const isKimiCodeAvailable = async (): Promise<boolean> => {
  try {
    await promisify(execFile)(getKimiCodeBinary(), ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getKimiCodeVersion = async (): Promise<string> => {
  try {
    const { stdout } = await promisify(execFile)(getKimiCodeBinary(), ['--version'], {
      timeout: 5000,
    });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] || stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
};
