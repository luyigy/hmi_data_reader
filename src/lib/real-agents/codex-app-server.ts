import type { ChildProcess } from 'child_process';
import type { HarnessInteractionRequest, HarnessStreamCallbacks } from '@/lib/acpx/types';

type JsonRpcId = string | number;
type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
};

export interface CodexAppServerOptions {
  prompt: string;
  threadId?: string;
  workingDirectory: string;
  sandboxMode: string;
  approvalPolicy: 'never' | 'on-request';
  timeout: number | null;
  ephemeral?: boolean;
  model?: string;
  reasoningEffort?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => void;
  env?: NodeJS.ProcessEnv;
}

export const toCodexApprovalRequest = (
  method: string,
  params: Record<string, any>
): HarnessInteractionRequest | null => {
  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params.command === 'string' ? params.command : 'Codex command';
    const reason = typeof params.reason === 'string' ? params.reason : '';
    return {
      kind: 'permission_request',
      title: 'Codex 请求执行命令',
      message: reason || 'Codex 请求批准后执行命令。',
      rawContent: [command, reason].filter(Boolean).join('\n'),
      responseFormat: 'approve_deny',
      resumeStrategy: 'in_process',
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const reason = typeof params.reason === 'string' ? params.reason : '';
    const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : '';
    return {
      kind: 'permission_request',
      title: 'Codex 请求修改文件',
      message: reason || 'Codex 请求批准后修改文件。',
      rawContent: [grantRoot, reason].filter(Boolean).join('\n') || 'Codex file change',
      responseFormat: 'approve_deny',
      resumeStrategy: 'in_process',
    };
  }
  return null;
};

export const buildCodexApprovalResponse = (decision: 'approve' | 'deny') => ({
  decision: decision === 'approve' ? 'accept' : 'decline',
});

export const isSuccessfulCodexAppServerExit = (code: number | null, output: string) =>
  code === 0 && output.length > 0;

export const runCodexAppServer = async (options: CodexAppServerOptions) => {
  const { spawn } = await import('child_process');
  const child = spawn('codex', ['app-server', '--stdio'], {
    cwd: options.workingDirectory,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  options.onSpawn?.(child);

  let nextId = 1;
  let buffer = '';
  let output = '';
  let activeThreadId = options.threadId;
  let completed = false;
  const pending = new Map<JsonRpcId, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  const send = (message: JsonRpcMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  let finishTurn!: () => void;
  let failTurn!: (error: Error) => void;
  const turnDone = new Promise<void>((resolve, reject) => {
    finishTurn = resolve;
    failTurn = reject;
  });

  const handleServerRequest = async (message: JsonRpcMessage) => {
    const approval = message.method && message.params
      ? toCodexApprovalRequest(message.method, message.params)
      : null;
    if (!approval || message.id === undefined) {
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
      }
      return;
    }
    try {
      const decision = await options.streamCallbacks?.onInteractionRequest?.(approval) ?? 'deny';
      send({ id: message.id, result: buildCodexApprovalResponse(decision) });
    } catch {
      send({ id: message.id, result: buildCodexApprovalResponse('deny') });
    }
  };

  const handleMessage = (message: JsonRpcMessage) => {
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'Codex app-server request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void handleServerRequest(message);
      return;
    }
    if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
      output += message.params.delta;
      void options.streamCallbacks?.onStdoutChunk?.(message.params.delta);
    } else if (message.method === 'turn/completed') {
      completed = true;
      const status = message.params?.turn?.status;
      if (status === 'failed') failTurn(new Error(message.params?.turn?.error?.message || 'Codex turn failed'));
      else finishTurn();
    }
  };

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line)); }
      catch { void options.streamCallbacks?.onStderrChunk?.(`Invalid Codex app-server message: ${line}`); }
    }
  });
  child.stderr.on('data', (data) => void options.streamCallbacks?.onStderrChunk?.(data.toString()));
  child.on('error', failTurn);
  child.on('close', (code) => {
    const error = new Error(`Codex app-server exited with code ${code}`);
    pending.forEach((waiter) => waiter.reject(error));
    pending.clear();
    if (!completed) {
      if (isSuccessfulCodexAppServerExit(code, output)) finishTurn();
      else failTurn(error);
    }
  });

  const timeoutId = typeof options.timeout === 'number' && options.timeout > 0
    ? setTimeout(() => {
        child.kill('SIGTERM');
        failTurn(new Error(`Codex execution timed out after ${options.timeout}ms`));
      }, options.timeout)
    : null;

  try {
    await request('initialize', {
      clientInfo: { name: 'agent-platform-v2', title: 'Agent Platform', version: '0.1.0' },
    });
    send({ method: 'initialized', params: {} });
    if (activeThreadId) {
      const resumed = await request('thread/resume', { threadId: activeThreadId });
      activeThreadId = resumed.thread?.id || activeThreadId;
    } else {
      const started = await request('thread/start', {
        cwd: options.workingDirectory,
        sandbox: options.sandboxMode,
        approvalPolicy: options.approvalPolicy,
        ephemeral: Boolean(options.ephemeral),
        ...(options.model ? { model: options.model } : {}),
      });
      activeThreadId = started.thread.id;
    }
    options.onThreadStarted?.(activeThreadId!);
    await request('turn/start', {
      threadId: activeThreadId,
      input: [{ type: 'text', text: options.prompt }],
      approvalPolicy: options.approvalPolicy,
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    });
    await turnDone;
    return { output: output || 'Task executed successfully', threadId: activeThreadId! };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    child.kill('SIGTERM');
  }
};
