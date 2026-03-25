import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import type { ChildProcess } from 'child_process';
import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import type { RemoteHarnessHostRecord } from './hosts';

interface RemoteHarnessTask {
  id: string;
  name: string;
  description?: string;
}

interface RemoteSshExecutionOptions {
  timeout: number;
  harnessType: string;
  host: RemoteHarnessHostRecord;
  resumeSessionId?: string;
  continuationMessage?: string;
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

const createPrompt = (task: RemoteHarnessTask) => `Task: ${task.name}

${task.description ? `Description: ${task.description}` : 'Please complete this task.'}

Please complete this task step by step. When you're done, provide a concise summary of:
1. What you did
2. Any files you modified
3. Any issues you encountered
`;

const buildRemoteCommand = (
  harnessType: string,
  workingDirectory?: string | null,
  resumeSessionId?: string
) => {
  const quotedCwd = workingDirectory ? `cd ${shellQuote(workingDirectory)} && ` : '';
  let command: string;

  if (harnessType === 'codex') {
    command = resumeSessionId
      ? `printf '__ACPX_REMOTE_COMMAND_START__\\n' >&2; ${quotedCwd}codex exec resume ${shellQuote(resumeSessionId)} --json --skip-git-repo-check -`
      : `printf '__ACPX_REMOTE_COMMAND_START__\\n' >&2; ${quotedCwd}codex exec --json --skip-git-repo-check -`;
  } else if (harnessType === 'claude') {
    command = resumeSessionId
      ? `printf '__ACPX_REMOTE_COMMAND_START__\\n' >&2; ${quotedCwd}PROMPT=$(cat) && claude --resume ${shellQuote(resumeSessionId)} --print --verbose --output-format stream-json --permission-mode bypassPermissions "$PROMPT"`
      : `printf '__ACPX_REMOTE_COMMAND_START__\\n' >&2; ${quotedCwd}PROMPT=$(cat) && claude --print --verbose --output-format stream-json --permission-mode bypassPermissions "$PROMPT"`;
  } else {
    throw new Error(`Unsupported remote harness: ${harnessType}`);
  }

  return `bash -lc ${shellQuote(command)}`;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const extractClaudeModifiedFiles = (output: string): string[] => {
  const filePattern = /(modified|created|deleted):\s*(.+)/gi;
  const files: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = filePattern.exec(output)) !== null) {
    files.push(match[2].trim());
  }

  return files;
};

export const executeRemoteSshTask = async (
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
  const { stdout, stderr, timing } = await runRemoteSshCommand({
    timeout: options.timeout,
    host: options.host,
    command: buildRemoteCommand(options.harnessType, options.host.workingDirectory, options.resumeSessionId),
    stdin: prompt,
    streamCallbacks:
      options.harnessType === 'codex'
        ? {
            onStdoutChunk: (chunk) => {
              codexStdoutBuffer += chunk;
              const lines = codexStdoutBuffer.split('\n');
              codexStdoutBuffer = lines.pop() ?? '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                  continue;
                }

                try {
                  const event = JSON.parse(trimmed) as {
                    type?: string;
                    thread_id?: string;
                    item?: { type?: string; text?: string };
                  };
                  if (typeof event.thread_id === 'string' && event.thread_id.trim()) {
                    codexThreadId = event.thread_id.trim();
                  }
                  const text =
                    event.type === 'item.completed'
                    && event.item?.type === 'agent_message'
                    && typeof event.item.text === 'string'
                      ? event.item.text
                      : null;

                  if (text) {
                    codexResolvedText = text;
                    void options.streamCallbacks?.onStdoutChunk?.(text);
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
            onStdoutChunk: (chunk) => {
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
        : options.streamCallbacks,
    onSpawn: options.onSpawn,
    onProgress: options.onProgress,
  });

  if (options.harnessType === 'codex' && codexStdoutBuffer.trim()) {
    try {
      const event = JSON.parse(codexStdoutBuffer.trim()) as {
        type?: string;
        thread_id?: string;
        item?: { type?: string; text?: string };
      };
      if (typeof event.thread_id === 'string' && event.thread_id.trim()) {
        codexThreadId = event.thread_id.trim();
      }
      if (
        event.type === 'item.completed'
        && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string'
      ) {
        codexResolvedText = event.item.text;
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

  const output =
    options.harnessType === 'codex'
      ? codexResolvedText || stdout || stderr || 'Remote codex completed'
      : options.harnessType === 'claude'
      ? claudeResolvedText || stdout || stderr || 'Remote claude completed'
      : stdout || stderr || `Remote ${options.harnessType} completed`;

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
        : undefined,
    sessionKind:
      options.harnessType === 'codex'
        ? 'codex_thread'
        : options.harnessType === 'claude'
        ? 'claude_session'
        : undefined,
    timing,
  };
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
    command,
  ];

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
  const supported = host.supportedHarnesses;
  const cwdSnippet = host.workingDirectory ? `cd ${shellQuote(host.workingDirectory)} && ` : '';
  const probeScript = [
    `${cwdSnippet}printf 'whoami=%s\\n' \"$(whoami)\"`,
    `${cwdSnippet}printf 'hostname=%s\\n' \"$(hostname)\"`,
    `${cwdSnippet}printf 'pwd=%s\\n' \"$(pwd)\"`,
    ...supported.map(
      (harness) =>
        `${cwdSnippet}if command -v ${harness} >/dev/null 2>&1; then printf '${harness}=ok '; ${harness} --version | head -n 1; else printf '${harness}=missing\\n'; fi`
    ),
  ].join('; ');

  const { stdout, stderr } = await runRemoteSshCommand({
    timeout,
    host,
    command: `bash -lc ${shellQuote(probeScript)}`,
  });

  return {
    success: true,
    output: stdout || stderr || 'SSH probe completed',
    executionTime: Date.now() - startedAt,
  };
};
