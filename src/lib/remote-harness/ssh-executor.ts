import { piSizeProbeCommand, withRemotePiSessionSize } from './ssh-session-size';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import type { ChildProcess } from 'child_process';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import { processCodexJsonLine } from '@/lib/real-agents/codex-event-parser';
import type { RemoteHarnessHostRecord } from './hosts';

interface RemoteHarnessTask {
  id: string;
  name: string;
  description?: string;
}

interface RemoteSshExecutionOptions {
  onSessionSize?: (sessionId: string, size: { totalBytes: number; deltaBytes?: number }) => void | Promise<void>;
  timeout: number;
  harnessType: string;
  host: RemoteHarnessHostRecord;
  resumeSessionId?: string;
  continuationMessage?: string;
  model?: string;
  reasoningEffort?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onProgress?: (event: {
    phase: 'ssh_spawned' | 'remote_command_started' | 'first_stdout' | 'first_stderr' | 'streaming_output' | 'completed';
    at: number;
  }) => void;
}

interface RemoteSshCommandOptions {
  timeout: number;
  host: RemoteHarnessHostRecord;
  command: string;
  stdin?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onProgress?: (event: {
    phase: 'ssh_spawned' | 'remote_command_started' | 'first_stdout' | 'first_stderr' | 'streaming_output' | 'completed';
    at: number;
  }) => void;
}

export interface RemoteSshExecutionResult {
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  threadId?: string;
  sessionId?: string;
  sessionKind?: string;
  timing: {
    sshStartMs: number;
    remoteCommandStartMs?: number;
    firstStdoutMs?: number;
    firstStderrMs?: number;
    totalMs: number;
  };
}

export interface RemoteSshProbeResult {
  success: boolean;
  output: string;
  executionTime: number;
}

interface PiJsonEvent {
  type?: string;
  toolName?: string;
  args?: unknown;
  success?: boolean;
  finalError?: string;
  message?: {
    stopReason?: string;
    errorMessage?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

const createPrompt = (task: RemoteHarnessTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a concise summary of:
1. What you did
2. Any files you modified
3. Any issues you encountered
`;

const DEFAULT_REMOTE_PI_BIN = process.env.REMOTE_PI_AGENT_BIN?.trim() || 'pi';
const DEFAULT_REMOTE_PI_SESSION_DIR = process.env.REMOTE_PI_AGENT_SESSION_DIR?.trim()
  || '$HOME/.pi/agent/sessions';
const DEFAULT_REMOTE_PI_TOOLS = process.env.REMOTE_PI_AGENT_TOOLS?.trim()
  || 'read,bash,edit,write,grep,find,ls';

const slugify = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'default';

const resolveRemotePiSessionDir = (taskId: string, resumeSessionId?: string) =>
  resumeSessionId?.trim() || `${DEFAULT_REMOTE_PI_SESSION_DIR}/acpx-${slugify(taskId)}`;

const toUnixShellPathExpr = (value: string) => {
  if (value.startsWith('~/')) {
    return `"${'$'}HOME/${value.slice(2)}"`;
  }

  if (value === '~') {
    return `"${'$'}HOME"`;
  }

  if (value.startsWith('$HOME/')) {
    return `"${'$'}HOME/${value.slice('$HOME/'.length)}"`;
  }

  if (value === '$HOME') {
    return `"${'$'}HOME"`;
  }

  return shellQuote(value);
};

const toPowerShellPathExpr = (value: string) => {
  if (value.startsWith('~/')) {
    return `"${'$'}HOME/${value.slice(2)}"`;
  }

  if (value === '~') {
    return '$HOME';
  }

  if (value.startsWith('$HOME/')) {
    return `"${'$'}HOME/${value.slice('$HOME/'.length)}"`;
  }

  if (value === '$HOME') {
    return '$HOME';
  }

  return powerShellQuote(value);
};

const getRemoteExecutableName = (harnessType: string) => {
  if (harnessType === 'pi-agent') {
    return DEFAULT_REMOTE_PI_BIN;
  }

  return harnessType;
};

const buildRemoteCommand = (
  harnessType: string,
  workingDirectory?: string | null,
  taskId = 'default',
  resumeSessionId?: string,
  shellMode: 'unix' | 'powershell' = 'unix',
  model?: string,
  reasoningEffort?: string
) => {
  if (shellMode === 'powershell') {
    return buildRemotePowerShellCommand(harnessType, workingDirectory, taskId, resumeSessionId, model, reasoningEffort);
  }

  const quotedCwd = workingDirectory ? `cd ${shellQuote(workingDirectory)} && ` : '';
  const executable = getRemoteExecutableName(harnessType);
  const remotePiSessionDir = resolveRemotePiSessionDir(taskId, resumeSessionId);
  const preflight = [
    'echo __ACPX_REMOTE_COMMAND_START__ >&2',
    `${quotedCwd}echo "__ACPX_PREFLIGHT_PWD__=$(pwd)" >&2`,
    `${quotedCwd}echo "__ACPX_PREFLIGHT_PATH__=$PATH" >&2`,
    `${quotedCwd}echo "__ACPX_PREFLIGHT_WHICH__=$(command -v ${shellQuote(executable)} 2>/dev/null || echo missing)" >&2`,
  ].join('; ');
  let command: string;

  if (harnessType === 'codex') {
    const overrides = `${model ? ` --model ${shellQuote(model)}` : ''}${reasoningEffort ? ` --config ${shellQuote(`model_reasoning_effort="${reasoningEffort}"`)}` : ''}`;
    command = resumeSessionId
      ? `${preflight}; ${quotedCwd}codex exec resume ${shellQuote(resumeSessionId)} --json${overrides} --skip-git-repo-check -`
      : `${preflight}; ${quotedCwd}codex exec --json${overrides} --skip-git-repo-check -`;
  } else if (harnessType === 'claude') {
    command = resumeSessionId
      ? `${preflight}; ${quotedCwd}PROMPT=$(cat) && claude --resume ${shellQuote(resumeSessionId)} --print --verbose --output-format stream-json --permission-mode bypassPermissions "$PROMPT"`
      : `${preflight}; ${quotedCwd}PROMPT=$(cat) && claude --print --verbose --output-format stream-json --permission-mode bypassPermissions "$PROMPT"`;
  } else if (harnessType === 'pi-agent') {
    command = resumeSessionId
      ? `${preflight}; ${quotedCwd}export PATH="$HOME/.local/node/bin:$PATH"; PROMPT=$(cat) && ${shellQuote(executable)} --mode json --tools ${shellQuote(DEFAULT_REMOTE_PI_TOOLS)} --session-dir ${toUnixShellPathExpr(remotePiSessionDir)} --continue "$PROMPT"`
      : `${preflight}; ${quotedCwd}export PATH="$HOME/.local/node/bin:$PATH"; PROMPT=$(cat) && ${shellQuote(executable)} --mode json --tools ${shellQuote(DEFAULT_REMOTE_PI_TOOLS)} -p --session-dir ${toUnixShellPathExpr(remotePiSessionDir)} "$PROMPT"`;
  } else {
    throw new Error(`Unsupported remote harness: ${harnessType}`);
  }

  return `bash -lc ${shellQuote(command)}`;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
const powerShellQuote = (value: string) => `'${value.replace(/'/g, `''`)}'`;

const normalizePiToolName = (toolName?: string | null) => {
  const normalized = (toolName || '').trim().toLowerCase();
  if (!normalized) {
    return 'Task';
  }

  const knownNames: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    grep: 'Grep',
    find: 'Glob',
    ls: 'Read',
  };

  return knownNames[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const sanitizePiResolvedText = (text: string) =>
  text
    .trim()
    .replace(/^<\|channel\>thought\s*/i, '')
    .replace(/^<channel\|>/i, '')
    .trim();

const extractPiAssistantText = (event: PiJsonEvent): string | null => {
  if (event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) {
    return null;
  }

  const text = event.message.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('');

  const normalized = sanitizePiResolvedText(text);
  return normalized || null;
};

export const processPiJsonLine = (line: string, callbacks?: HarnessStreamCallbacks) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return { resolvedText: undefined as string | undefined, plainText: undefined as string | undefined };
  }

  try {
    const event = JSON.parse(trimmed) as PiJsonEvent;
    if (event.type === 'tool_execution_start') {
      const toolName = normalizePiToolName(event.toolName);
      void callbacks?.onToolEvent?.({
        toolName,
        preview: buildToolPreview(event.args),
        emoji: getToolEmoji(toolName),
      });
    }

    const resolvedText =
      event.type === 'message_end' || event.type === 'turn_end'
        ? extractPiAssistantText(event) || undefined
        : undefined;
    if (resolvedText) {
      void callbacks?.onStdoutChunk?.(resolvedText);
    }

    const errorMessage = event.type === 'auto_retry_end'
      ? event.success === false ? event.finalError?.trim() || 'Pi Agent retry failed' : ''
      : (event.type === 'message_end' || event.type === 'turn_end') && event.message?.role === 'assistant'
        ? event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
          ? event.message.errorMessage?.trim() || `Pi Agent ${event.message.stopReason}` : ''
        : undefined;
    return {
      resolvedText,
      errorMessage,
      plainText: undefined as string | undefined,
    };
  } catch {
    const plainText = sanitizePiResolvedText(trimmed);
    return {
      resolvedText: undefined as string | undefined,
      plainText: plainText || undefined,
    };
  }
};

const isLegacyPiTextToolCall = (output: string) =>
  /^call:[a-z0-9_-]+\{[\s\S]*\}$/i.test(output.trim());

const buildRemotePowerShellCommand = (
  harnessType: string,
  workingDirectory?: string | null,
  taskId?: string,
  resumeSessionId?: string,
  model?: string,
  reasoningEffort?: string
) => {
  const prelude = [
    `$ErrorActionPreference = 'Stop'`,
    `[Console]::Error.WriteLine('__ACPX_REMOTE_COMMAND_START__')`,
    workingDirectory ? `Set-Location -LiteralPath ${powerShellQuote(workingDirectory)}` : null,
  ].filter(Boolean).join('; ');

  let script: string;
  const executable = getRemoteExecutableName(harnessType);
  const remotePiSessionDir = resolveRemotePiSessionDir(taskId || 'default', resumeSessionId);
  if (harnessType === 'codex') {
    const overrides = `${model ? ` --model ${powerShellQuote(model)}` : ''}${reasoningEffort ? ` --config ${powerShellQuote(`model_reasoning_effort="${reasoningEffort}"`)}` : ''}`;
    script = resumeSessionId
      ? `${prelude}; & codex exec resume ${powerShellQuote(resumeSessionId)} --json${overrides} --skip-git-repo-check -`
      : `${prelude}; & codex exec --json${overrides} --skip-git-repo-check -`;
  } else if (harnessType === 'claude') {
    script = resumeSessionId
      ? `${prelude}; $prompt = [Console]::In.ReadToEnd(); & claude --resume ${powerShellQuote(resumeSessionId)} --print --verbose --output-format stream-json --permission-mode bypassPermissions $prompt`
      : `${prelude}; $prompt = [Console]::In.ReadToEnd(); & claude --print --verbose --output-format stream-json --permission-mode bypassPermissions $prompt`;
  } else if (harnessType === 'pi-agent') {
    // Let pi read SSH stdin directly; Windows PowerShell mangles quotes in native argv.
    script = resumeSessionId
      ? `${prelude}; & ${powerShellQuote(executable)} --mode json --tools ${powerShellQuote(DEFAULT_REMOTE_PI_TOOLS)} --session-dir ${toPowerShellPathExpr(remotePiSessionDir)} --continue`
      : `${prelude}; & ${powerShellQuote(executable)} --mode json --tools ${powerShellQuote(DEFAULT_REMOTE_PI_TOOLS)} -p --session-dir ${toPowerShellPathExpr(remotePiSessionDir)}`;
  } else {
    throw new Error(`Unsupported remote harness: ${harnessType}`);
  }

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
};

const shouldRetryWithPowerShell = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  // cmd.exe quotes the missing command even when its localized message is not UTF-8.
  return /^'(?:bash|printf)'\s/m.test(message) || [
    'printf: usage: printf',
    '\'bash\' is not recognized',
    '\'printf\' is not recognized',
    'Set-Location',
  ].some((pattern) => message.includes(pattern));
};

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? '');

const buildProbeCommand = (
  host: RemoteHarnessHostRecord,
  shellMode: 'unix' | 'powershell' = 'unix'
) => {
  if (shellMode === 'powershell') {
    const prelude = [
      `$ErrorActionPreference = 'Stop'`,
      host.workingDirectory ? `Set-Location -LiteralPath ${powerShellQuote(host.workingDirectory)}` : null,
    ].filter(Boolean).join('; ');
    const harnessChecks = host.supportedHarnesses.map(
      (harness) => {
        const executable = getRemoteExecutableName(harness);
        return `if (Get-Command ${powerShellQuote(executable)} -ErrorAction SilentlyContinue) { ` +
        `$version = (& ${powerShellQuote(executable)} --version | Select-Object -First 1); ` +
        `Write-Output "${harness}=ok $version" } else { Write-Output "${harness}=missing" }`;
      }
    );
    const script = [
      prelude,
      `Write-Output ("whoami=" + (whoami))`,
      `$hostname = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { hostname }`,
      `Write-Output ("hostname=" + $hostname)`,
      `Write-Output ("pwd=" + (Get-Location).Path)`,
      ...harnessChecks,
    ].filter(Boolean).join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  }

  const cwdSnippet = host.workingDirectory ? `cd ${shellQuote(host.workingDirectory)} && ` : '';
  const probeScript = [
    `${cwdSnippet}echo whoami=\"$(whoami)\"`,
    `${cwdSnippet}echo hostname=\"$(hostname)\"`,
    `${cwdSnippet}echo pwd=\"$(pwd)\"`,
    ...host.supportedHarnesses.map(
      (harness) => {
        const executable = getRemoteExecutableName(harness);
        return `${cwdSnippet}export PATH="$HOME/.local/node/bin:$PATH"; if command -v ${shellQuote(executable)} >/dev/null 2>&1; then echo '${harness}=ok' && ${shellQuote(executable)} --version | head -n 1; else echo '${harness}=missing'; fi`;
      }
    ),
  ].join('; ');

  return `bash -lc ${shellQuote(probeScript)}`;
};

const extractClaudeModifiedFiles = (output: string): string[] => {
  const filePattern = /(modified|created|deleted):\s*(.+)/gi;
  const files: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = filePattern.exec(output)) !== null) {
    files.push(match[2].trim());
  }

  return files;
};

const executeRemoteSshTaskWithoutTelemetry = async (
  task: RemoteHarnessTask,
  options: RemoteSshExecutionOptions
): Promise<RemoteSshExecutionResult> => {
  const prompt =
    options.resumeSessionId && options.continuationMessage
      ? options.continuationMessage
      : createPrompt(task);
  const startedAt = Date.now();
  let codexResolvedText = '';
  let codexStdoutBuffer = '';
  let codexThreadId: string | undefined;
  let claudeResolvedText = '';
  let claudeStdoutBuffer = '';
  let claudeSessionId: string | undefined;
  let piResolvedText = '';
  let piError = '';
  let piStdoutBuffer = '';
  const streamCallbacks =
    options.harnessType === 'codex'
      ? {
          onStdoutChunk: (chunk: string) => {
            codexStdoutBuffer += chunk;
            const lines = codexStdoutBuffer.split('\n');
            codexStdoutBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                continue;
              }

              try {
                const parsed = processCodexJsonLine(trimmed, options.streamCallbacks);
                if (parsed.threadId) {
                  codexThreadId = parsed.threadId;
                }
                if (parsed.resolvedText) {
                  codexResolvedText = parsed.resolvedText;
                  void options.streamCallbacks?.onStdoutChunk?.(parsed.resolvedText);
                }
              } catch {
                void options.streamCallbacks?.onStdoutChunk?.(trimmed);
              }
            }
          },
          onStderrChunk: options.streamCallbacks?.onStderrChunk,
        }
      : options.harnessType === 'claude'
      ? {
          onStdoutChunk: (chunk: string) => {
            claudeStdoutBuffer += chunk;
            const lines = claudeStdoutBuffer.split('\n');
            claudeStdoutBuffer = lines.pop() ?? '';

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
                  claudeSessionId = event.session_id.trim();
                }
                if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                  const text = event.message.content
                    .filter((item) => item.type === 'text' && typeof item.text === 'string')
                    .map((item) => item.text as string)
                    .join('');

                  if (text) {
                    claudeResolvedText = text;
                    void options.streamCallbacks?.onStdoutChunk?.(text);
                  }
                  continue;
                }
                if (event.type === 'result' && typeof event.result === 'string') {
                  claudeResolvedText = event.result;
                }
              } catch {
                void options.streamCallbacks?.onStdoutChunk?.(trimmed);
              }
            }
          },
          onStderrChunk: options.streamCallbacks?.onStderrChunk,
        }
      : options.harnessType === 'pi-agent'
      ? {
          onStdoutChunk: (chunk: string) => {
            piStdoutBuffer += chunk;
            const lines = piStdoutBuffer.split('\n');
            piStdoutBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const parsed = processPiJsonLine(line, options.streamCallbacks);
              if (parsed.errorMessage !== undefined) piError = parsed.errorMessage;
              if (parsed.resolvedText) {
                piResolvedText = parsed.resolvedText;
              } else if (parsed.plainText) {
                void options.streamCallbacks?.onStdoutChunk?.(parsed.plainText);
              }
            }
          },
          onStderrChunk: options.streamCallbacks?.onStderrChunk,
        }
      : options.streamCallbacks;

  let stdout: string;
  let stderr: string;
  let timing: {
    sshStartMs: number;
    remoteCommandStartMs?: number;
    firstStdoutMs?: number;
    firstStderrMs?: number;
    totalMs: number;
  };

  try {
    console.log(
      `[Remote SSH] Starting ${options.harnessType} run on ${options.host.label} (${options.host.host}) via unix shell`
    );
    ({ stdout, stderr, timing } = await runRemoteSshCommand({
      timeout: options.timeout,
      host: options.host,
      command: buildRemoteCommand(options.harnessType, options.host.workingDirectory, task.id, options.resumeSessionId, 'unix', options.model, options.reasoningEffort),
      stdin: prompt,
      streamCallbacks,
      onSpawn: options.onSpawn,
      onProgress: options.onProgress,
    }));
  } catch (error) {
    const retryWithPowerShell = shouldRetryWithPowerShell(error);
    console.warn(
      `[Remote SSH] Unix shell failed for ${options.harnessType} on ${options.host.label} (${options.host.host}); ` +
      `retryWithPowerShell=${retryWithPowerShell}; error=${JSON.stringify(toErrorMessage(error))}`
    );

    if (!retryWithPowerShell) {
      throw error;
    }

    try {
      console.log(
        `[Remote SSH] Retrying ${options.harnessType} run on ${options.host.label} (${options.host.host}) via powershell shell`
      );
      ({ stdout, stderr, timing } = await runRemoteSshCommand({
        timeout: options.timeout,
        host: options.host,
        command: buildRemoteCommand(options.harnessType, options.host.workingDirectory, task.id, options.resumeSessionId, 'powershell', options.model, options.reasoningEffort),
        stdin: prompt,
        streamCallbacks,
        onSpawn: options.onSpawn,
        onProgress: options.onProgress,
      }));
    } catch (retryError) {
      console.warn(
        `[Remote SSH] PowerShell retry failed for ${options.harnessType} on ${options.host.label} (${options.host.host}); ` +
        `error=${JSON.stringify(toErrorMessage(retryError))}`
      );
      throw retryError;
    }
  }

  if (options.harnessType === 'codex' && codexStdoutBuffer.trim()) {
    try {
      const parsed = processCodexJsonLine(codexStdoutBuffer.trim(), options.streamCallbacks);
      if (parsed.threadId) {
        codexThreadId = parsed.threadId;
      }
      if (parsed.resolvedText) {
        codexResolvedText = parsed.resolvedText;
      }
    } catch {
      void options.streamCallbacks?.onStdoutChunk?.(codexStdoutBuffer.trim());
    }
  }

  if (options.harnessType === 'claude' && claudeStdoutBuffer.trim()) {
    try {
      const event = JSON.parse(claudeStdoutBuffer.trim()) as {
        session_id?: string;
        result?: string;
      };
      if (typeof event.session_id === 'string' && event.session_id.trim()) {
        claudeSessionId = event.session_id.trim();
      }
      if (typeof event.result === 'string') {
        claudeResolvedText = event.result;
      }
    } catch {
      void options.streamCallbacks?.onStdoutChunk?.(claudeStdoutBuffer.trim());
    }
  }

  if (options.harnessType === 'pi-agent' && piStdoutBuffer.trim()) {
    const parsed = processPiJsonLine(piStdoutBuffer.trim(), options.streamCallbacks);
    if (parsed.errorMessage !== undefined) piError = parsed.errorMessage;
    if (parsed.resolvedText) {
      piResolvedText = parsed.resolvedText;
    } else if (parsed.plainText) {
      void options.streamCallbacks?.onStdoutChunk?.(parsed.plainText);
    }
  }

  if (piError) throw new Error(piError);

  const output =
    options.harnessType === 'codex'
      ? codexResolvedText || stdout || stderr || 'Remote codex completed'
      : options.harnessType === 'claude'
      ? claudeResolvedText || stdout || stderr || 'Remote claude completed'
      : options.harnessType === 'pi-agent'
      ? piResolvedText || sanitizePiResolvedText(stdout) || stderr || 'Remote pi-agent completed'
      : stdout || stderr || `Remote ${options.harnessType} completed`;

  if (options.harnessType === 'pi-agent' && isLegacyPiTextToolCall(output)) {
    throw new Error(
      `Remote pi-agent returned a legacy textual tool call instead of executing tools: ${output.trim()}`
    );
  }

  return {
    output,
    filesModified: options.harnessType === 'claude' ? extractClaudeModifiedFiles(output) : [],
    executionTime: Date.now() - startedAt,
    liveStreaming: true,
    threadId: options.harnessType === 'codex' ? codexThreadId : undefined,
    sessionId:
      options.harnessType === 'codex'
        ? codexThreadId
        : options.harnessType === 'claude'
        ? claudeSessionId
        : options.harnessType === 'pi-agent'
        ? resolveRemotePiSessionDir(task.id, options.resumeSessionId)
        : undefined,
    sessionKind:
      options.harnessType === 'codex'
        ? 'codex_thread'
        : options.harnessType === 'claude'
        ? 'claude_session'
        : options.harnessType === 'pi-agent'
        ? 'pi_session_dir'
        : undefined,
    timing,
  };
};

export const executeRemoteSshTask = async (task: RemoteHarnessTask, options: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
  const execute = () => executeRemoteSshTaskWithoutTelemetry(task, options);
  if (options.harnessType !== 'pi-agent' || !options.onSessionSize) return execute();
  const sessionId = resolveRemotePiSessionDir(task.id, options.resumeSessionId);
  return withRemotePiSessionSize({
    execute,
    publish: size => options.onSessionSize!(sessionId, size),
    read: async () => {
      const probe = (windows: boolean) => runRemoteSshCommand({ host: options.host, timeout: 5000, command: piSizeProbeCommand(sessionId, windows) });
      try { return (await probe(false)).stdout; }
      catch (error) { if (shouldRetryWithPowerShell(error)) return (await probe(true)).stdout; throw error; }
    },
  });
};

const runRemoteSshCommand = async ({
  timeout,
  host,
  command,
  stdin,
  streamCallbacks,
  onSpawn,
  onProgress,
}: RemoteSshCommandOptions): Promise<{
  stdout: string;
  stderr: string;
  timing: {
    sshStartMs: number;
    remoteCommandStartMs?: number;
    firstStdoutMs?: number;
    firstStderrMs?: number;
    totalMs: number;
  };
}> => {
  const { spawn } = await import('child_process');
  const startedAt = Date.now();
  const sshKeyPath = host.privateKey
    ? join(tmpdir(), `acpx-remote-key-${process.pid}-${Date.now()}`)
    : null;

  if (host.authType !== 'ssh_key') {
    throw new Error(`Unsupported remote SSH auth type: ${host.authType}`);
  }

  if (!host.privateKey) {
    throw new Error(`Remote SSH host "${host.label}" is missing a private key`);
  }

  if (sshKeyPath) {
    await fs.writeFile(sshKeyPath, `${host.privateKey.trim()}\n`, { mode: 0o600 });
  }

  const sshArgs = [
    '-i',
    sshKeyPath!,
    '-p',
    String(host.port || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    `${host.sshUser}@${host.host}`,
  ];
  sshArgs.push(command);

  try {
    return await new Promise<{
      stdout: string;
      stderr: string;
      timing: {
        sshStartMs: number;
        remoteCommandStartMs?: number;
        firstStdoutMs?: number;
        firstStderrMs?: number;
        totalMs: number;
      };
    }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let remoteCommandStartedAt: number | undefined;
      let firstStdoutAt: number | undefined;
      let firstStderrAt: number | undefined;
      let lastStreamingAt = 0;
      const child = spawn('ssh', sshArgs, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      onSpawn?.(child);
      onProgress?.({ phase: 'ssh_spawned', at: Date.now() });

      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Remote SSH execution timed out after ${timeout}ms`));
      }, timeout);

      if (stdin) {
        child.stdin.write(stdin);
      }
      child.stdin.end();

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        if (!firstStdoutAt) {
          firstStdoutAt = Date.now();
          onProgress?.({ phase: 'first_stdout', at: firstStdoutAt });
        }
        if (Date.now() - lastStreamingAt > 1000) {
          lastStreamingAt = Date.now();
          onProgress?.({ phase: 'streaming_output', at: lastStreamingAt });
        }
        stdout += chunk;
        void streamCallbacks?.onStdoutChunk?.(chunk);
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.split('\n');
        const forwardedLines: string[] = [];

        for (const line of lines) {
          if (line.trim() === '__ACPX_REMOTE_COMMAND_START__') {
            if (!remoteCommandStartedAt) {
              remoteCommandStartedAt = Date.now();
              onProgress?.({ phase: 'remote_command_started', at: remoteCommandStartedAt });
            }
            continue;
          }
          forwardedLines.push(line);
        }

        const forwarded = forwardedLines.join('\n');
        if (forwarded) {
          if (!firstStderrAt) {
            firstStderrAt = Date.now();
            onProgress?.({ phase: 'first_stderr', at: firstStderrAt });
          }
          if (Date.now() - lastStreamingAt > 1000) {
            lastStreamingAt = Date.now();
            onProgress?.({ phase: 'streaming_output', at: lastStreamingAt });
          }
          stderr += forwarded;
          void streamCallbacks?.onStderrChunk?.(forwarded);
        }
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);

        if (code === 0) {
          const completedAt = Date.now();
          onProgress?.({ phase: 'completed', at: completedAt });
          resolve({
            stdout,
            stderr,
            timing: {
              sshStartMs: 0,
              remoteCommandStartMs: remoteCommandStartedAt ? remoteCommandStartedAt - startedAt : undefined,
              firstStdoutMs: firstStdoutAt ? firstStdoutAt - startedAt : undefined,
              firstStderrMs: firstStderrAt ? firstStderrAt - startedAt : undefined,
              totalMs: completedAt - startedAt,
            },
          });
          return;
        }

        reject(new Error(stderr || `ssh exited with code ${code}`));
      });
    });
  } finally {
    if (sshKeyPath) {
      await fs.rm(sshKeyPath, { force: true }).catch(() => undefined);
    }
  }
};

export const probeRemoteSshHost = async (
  host: RemoteHarnessHostRecord,
  timeout = 15_000
): Promise<RemoteSshProbeResult> => {
  const startedAt = Date.now();
  let stdout: string;
  let stderr: string;

  try {
    console.log(`[Remote SSH Probe] Starting probe for ${host.label} (${host.host}) via unix shell`);
    ({ stdout, stderr } = await runRemoteSshCommand({
      timeout,
      host,
      command: buildProbeCommand(host, 'unix'),
    }));
  } catch (error) {
    const retryWithPowerShell = shouldRetryWithPowerShell(error);
    console.warn(
      `[Remote SSH Probe] Unix shell failed for ${host.label} (${host.host}); ` +
      `retryWithPowerShell=${retryWithPowerShell}; error=${JSON.stringify(toErrorMessage(error))}`
    );

    if (!retryWithPowerShell) {
      throw error;
    }

    try {
      console.log(`[Remote SSH Probe] Retrying probe for ${host.label} (${host.host}) via powershell shell`);
      ({ stdout, stderr } = await runRemoteSshCommand({
        timeout,
        host,
        command: buildProbeCommand(host, 'powershell'),
      }));
    } catch (retryError) {
      console.warn(
        `[Remote SSH Probe] PowerShell retry failed for ${host.label} (${host.host}); ` +
        `error=${JSON.stringify(toErrorMessage(retryError))}`
      );
      throw retryError;
    }
  }

  return {
    success: true,
    output: stdout || stderr || 'SSH probe completed',
    executionTime: Date.now() - startedAt,
  };
};
