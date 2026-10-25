import type { HarnessSandbox } from '../harness/types';
import { parseAgentMessageInfo, type AgentMessageInfo } from '../agent-reply-state';
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChildProcess } from 'child_process';
import { realpathSync } from 'node:fs';
import type { HarnessInteractionRequest, HarnessSteer, HarnessStreamCallbacks } from '@/lib/acpx/types';
import { parseCodexTokenUsage } from '@/lib/codex-telemetry';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';

type JsonRpcId = string | number;
type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
};

class CodexRpcRejection extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CodexAppServerOptions {
  sandbox?: HarnessSandbox;
  prompt: string;
  threadId?: string;
  workingDirectory: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  networkAccess?: 'restricted' | 'enabled';
  readOnlyPaths?: string[];
  codexHome?: string;
  runtimeHome?: string;
  sandboxMode: string;
  approvalPolicy: 'never' | 'on-request';
  timeout: number | null;
  ephemeral?: boolean;
  model?: string;
  reasoningEffort?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onThreadStarted?: (threadId: string) => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerError extends Error {
  constructor(message: string, readonly safeToRetryJson: boolean) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CodexAppServerError';
  }
}

export const canRetryCodexAppServerWithJson = (
  error: unknown,
  workspaceRoot?: string
) => !workspaceRoot && error instanceof CodexAppServerError && error.safeToRetryJson;

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
      nativePermission: { method, scope: 'operation' },
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
      nativePermission: { method, scope: 'operation', grantRoot },
      message: reason || 'Codex 请求批准后修改文件。',
      rawContent: [grantRoot, reason].filter(Boolean).join('\n') || 'Codex file change',
      responseFormat: 'approve_deny',
      resumeStrategy: 'in_process',
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const reason = typeof params.reason === 'string' ? params.reason : '';
    return {
      kind: 'permission_request',
      title: 'Codex 请求临时权限',
      nativePermission: { method, scope: 'turn', permissions: params.permissions },
      message: reason || 'Codex 请求本 turn 的临时权限。',
      rawContent: JSON.stringify(params.permissions ?? {}),
      responseFormat: 'approve_deny',
      resumeStrategy: 'in_process',
    };
  }
  return null;
};

export const buildCodexApprovalResponse = (
  decision: 'approve' | 'deny',
  method?: string,
  params?: Record<string, any>
) => method === 'item/permissions/requestApproval'
  ? {
      permissions: decision === 'approve' ? params?.permissions ?? {} : {},
      scope: 'turn',
    }
  : { decision: decision === 'approve' ? 'accept' : 'decline' };

export const isSuccessfulCodexAppServerExit = (code: number | null, output: string) =>
  code === 0 && output.length > 0;

export const toCodexToolEvent = (item: Record<string, any> | undefined) => {
  if (!item) return null;

  const tool = item.type === 'commandExecution'
    ? { toolName: 'Bash', preview: buildToolPreview(item) }
    : item.type === 'fileChange'
    ? { toolName: 'Edit', preview: buildToolPreview(item.changes?.[0]) }
    : item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
    ? { toolName: item.tool || 'Task', preview: buildToolPreview(item.arguments) }
    : item.type === 'webSearch'
    ? { toolName: 'WebSearch', preview: buildToolPreview(item) }
    : null;

  return tool && { ...tool, emoji: getToolEmoji(tool.toolName) };
};

export const appendCodexAgentMessageDelta = (
  output: string,
  delta: string,
  startsNewMessage: boolean
) => `${output}${startsNewMessage && output ? '\n\n' : ''}${delta}`;

export const runCodexAppServer = async (options: CodexAppServerOptions) => {
  const runtimeCwd = options.workspaceRoot ? realpathSync(options.workingDirectory) : options.workingDirectory;
  const input = {
    command: 'codex', commandArgs: ['app-server', '--stdio'], cwd: runtimeCwd,
    workspaceRoot: options.workspaceRoot,
    writableRoots: options.extraWritableRoots, networkAccess: options.networkAccess,
    sandboxMode: options.sandboxMode, env: options.env ?? process.env,
    configPaths: [options.runtimeHome || options.codexHome || process.env.CODEX_HOME || `${process.env.HOME}/.codex`],
    readOnlyPaths: options.readOnlyPaths,
  };
  const sandbox = options.sandbox;
  if (sandbox) {
    if (!input.workspaceRoot) throw new Error('Managed Codex requires a restricted workspace');
    return sandbox.run({ ...input, workspaceRoot: input.workspaceRoot }, async managed => {
      return runCodexAppServerProtocol(options, managed.child, managed.control);
    });
  }
  let child: ChildProcess;
  try {
    const { spawn } = await import('child_process');
    const wrapped = wrapWithBubblewrap(input);
    child = spawn(wrapped.command, wrapped.args, { cwd: runtimeCwd, env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (error) {
    throw new CodexAppServerError(error instanceof Error ? error.message : 'Codex app-server failed to start', true);
  }
  options.onSpawn?.(child);
  return runCodexAppServerProtocol(options, child, child);
};

const runCodexAppServerProtocol = async (
  options: CodexAppServerOptions, child: ChildProcess,
  control: Pick<ChildProcess, 'kill'>,
) => {
  const runtimeCwd = options.workspaceRoot ? realpathSync(options.workingDirectory) : options.workingDirectory;
  let nextId = 1;
  let buffer = '';
  let output = '';
  let startsNewAgentMessage = false;
  const agentMessages = new Map<string, AgentMessageInfo>();
  let activeThreadId = options.threadId;
  let activeTurnId: string | undefined;
  let unregisterSteering: (() => void) | undefined;
  const steeringMessages = new Map<string, ReturnType<HarnessSteer>>();
  let completed = false;
  let closed = false;
  let turnSubmitted = false;
  let telemetryCallbacks = Promise.resolve();
  const pending = new Map<JsonRpcId, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  const send = (message: JsonRpcMessage) => {
    if (!closed && child.stdin!.writable) {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    }
  };
  const request = (method: string, params: Record<string, unknown>, timeoutMs = 30_000) =>
    new Promise<any>((resolve, reject) => {
      if (closed || child.killed || !child.stdin?.writable) {
        reject(new Error('Codex app-server unavailable'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} receipt timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          if (method === 'turn/start') activateSteering(value?.turn?.id);
          resolve(value);
        },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) { pending.get(id)?.reject(error); pending.delete(id); }
      });
    });
  const clearSteering = () => {
    activeTurnId = undefined;
    unregisterSteering?.();
    unregisterSteering = undefined;
  };
  const steer: HarnessSteer = (messageId, message) => {
    const previous = steeringMessages.get(messageId);
    if (previous) return previous;
    if (!activeThreadId || !activeTurnId || completed || closed || child.killed || !child.stdin?.writable) {
      return Promise.resolve('rejected');
    }
    const expectedTurnId = activeTurnId;
    const receipt = request('turn/steer', {
      threadId: activeThreadId, expectedTurnId,
      input: [{ type: 'text', text: message }],
    }, 5_000).then(
      (reply) => reply?.turnId === expectedTurnId ? 'accepted' as const : 'unknown' as const,
      (error) => error instanceof CodexRpcRejection ? 'rejected' as const : 'unknown' as const,
    ).then((status) => {
      queueTelemetryCallback(() => options.streamCallbacks?.onStderrChunk?.(
        `Codex steering: ${JSON.stringify({ messageId, threadId: activeThreadId, turnId: expectedTurnId, status })}`
      ));
      return status;
    });
    steeringMessages.set(messageId, receipt);
    return receipt;
  };
  const activateSteering = (turnId: unknown) => {
    if (typeof turnId !== 'string' || !turnId || completed || closed || child.killed) return;
    if (activeTurnId && activeTurnId !== turnId) return;
    activeTurnId = turnId;
    unregisterSteering ??= options.streamCallbacks?.onSteeringReady?.(steer);
  };
  const rejectPending = (error: Error) => {
    pending.forEach((waiter) => waiter.reject(error));
    pending.clear();
  };
  const queueTelemetryCallback = (callback: () => Promise<void> | void) => {
    telemetryCallbacks = telemetryCallbacks
      .then(callback)
      .catch((error) => {
        void options.streamCallbacks?.onStderrChunk?.(
          `Codex telemetry callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  };

  let finishTurn!: () => void;
  let failTurn!: (error: Error) => void;
  const turnDone = new Promise<void>((resolve, reject) => {
    finishTurn = resolve;
    failTurn = reject;
  });
  void turnDone.catch(() => {});

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
      send({
        id: message.id,
        result: buildCodexApprovalResponse(decision, message.method, message.params),
      });
    } catch {
      send({
        id: message.id,
        result: buildCodexApprovalResponse('deny', message.method, message.params),
      });
    }
  };

  const handleMessage = (message: JsonRpcMessage) => {
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new CodexRpcRejection(message.error.message || 'Codex app-server request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void handleServerRequest(message);
      return;
    }
    if (message.method?.startsWith('item/') && message.params?.threadId && message.params.threadId !== activeThreadId) return;
    if (message.method?.startsWith('item/') && activeTurnId && message.params?.turnId && message.params.turnId !== activeTurnId) return;
    if (message.method === 'turn/started' && message.params?.threadId === activeThreadId) {
      activateSteering(message.params?.turn?.id);
    } else if (message.method === 'item/started') {
      startsNewAgentMessage = message.params?.item?.type === 'agentMessage';
      if (startsNewAgentMessage) {
        const item = message.params?.item;
        const info = parseAgentMessageInfo({ id: item?.id, phase: item?.phase ?? null });
        if (info) agentMessages.set(info.id, info);
      }
      const toolEvent = toCodexToolEvent(message.params?.item);
      if (toolEvent) void options.streamCallbacks?.onToolEvent?.(toolEvent);
    } else if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
      const chunk = `${startsNewAgentMessage && output ? '\n\n' : ''}${message.params.delta}`;
      output = appendCodexAgentMessageDelta(output, message.params.delta, startsNewAgentMessage);
      startsNewAgentMessage = false;
      const id = message.params.itemId;
      const info = agentMessages.get(id) || parseAgentMessageInfo({ id, phase: null });
      void options.streamCallbacks?.onStdoutChunk?.(chunk, info);
    } else if (message.method === 'item/reasoning/summaryTextDelta' && typeof message.params?.delta === 'string') {
      const { itemId, summaryIndex, delta } = message.params;
      if (typeof itemId === 'string' && Number.isInteger(summaryIndex) && summaryIndex >= 0) {
        void options.streamCallbacks?.onStdoutChunk?.(delta, {
          id: `reasoning-summary:${itemId}:${summaryIndex}`, phase: 'reasoning_summary',
        });
      }
    } else if (message.method === 'item/completed' && message.params?.item?.type === 'reasoning') {
      const item = message.params.item;
      // Only the API's display summaries belong on the card; raw reasoning content is not forwarded.
      if (typeof item.id === 'string' && Array.isArray(item.summary)) item.summary.forEach((text: unknown, index: number) => {
        if (typeof text === 'string') void options.streamCallbacks?.onStdoutChunk?.(text, {
          id: `reasoning-summary:${item.id}:${index}`, phase: 'reasoning_summary', operation: 'replace',
        });
      });
    } else if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
      const item = message.params.item;
      const info = parseAgentMessageInfo({ id: item.id, phase: item.phase ?? null, operation: 'replace' });
      if (info && typeof item.text === 'string') void options.streamCallbacks?.onStdoutChunk?.(item.text, info);
    } else if (message.method === 'thread/tokenUsage/updated') {
      const usage = parseCodexTokenUsage(message.params);
      if (usage && options.streamCallbacks?.onCodexTokenUsage) {
        queueTelemetryCallback(() => options.streamCallbacks!.onCodexTokenUsage!(usage));
      }
    } else if (message.method === 'account/rateLimits/updated' && message.params?.rateLimits) {
      if (options.streamCallbacks?.onCodexRateLimits) {
        queueTelemetryCallback(() => options.streamCallbacks!.onCodexRateLimits!({
          rateLimits: message.params!.rateLimits,
          snapshot: false,
          collectedAt: new Date(),
        }));
      }
    } else if (message.method === 'turn/completed') {
      if (message.params?.threadId !== activeThreadId
        || (activeTurnId && message.params?.turn?.id !== activeTurnId)) return;
      completed = true;
      clearSteering();
      const status = message.params?.turn?.status;
      if (status === 'failed') failTurn(new Error(message.params?.turn?.error?.message || 'Codex turn failed'));
      else finishTurn();
    }
  };

  child.stdout!.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line)); }
      catch { void options.streamCallbacks?.onStderrChunk?.(`Invalid Codex app-server message: ${line}`); }
    }
  });
  child.stderr!.on('data', (data) => void options.streamCallbacks?.onStderrChunk?.(data.toString()));
  const failConnection = (error: Error) => {
    closed = true;
    clearSteering();
    rejectPending(error);
    failTurn(error);
  };
  child.stdin!.on('error', failConnection);
  child.on('error', failConnection);
  child.on('exit', () => {
    closed = true;
    clearSteering();
    rejectPending(new Error('Codex app-server exited before receipt'));
  });
  child.on('close', (code) => {
    closed = true;
    clearSteering();
    const error = new Error(`Codex app-server exited with code ${code}`);
    rejectPending(error);
    if (!completed) {
      if (isSuccessfulCodexAppServerExit(code, output)) finishTurn();
      else failTurn(error);
    }
  });

  const timeoutId = typeof options.timeout === 'number' && options.timeout > 0
    ? setTimeout(() => {
        control.kill('SIGTERM');
        failConnection(new Error(`Codex execution timed out after ${options.timeout}ms`));
      }, options.timeout)
    : null;

  try {
    await request('initialize', {
      clientInfo: { name: 'agent-platform-v2', title: 'Agent Platform', version: '0.1.0' },
    });
    send({ method: 'initialized', params: {} });
    const rateLimits = options.streamCallbacks?.onCodexRateLimits
      ? await request('account/rateLimits/read', {}).catch(() => null)
      : null;
    if (rateLimits?.rateLimits) {
      queueTelemetryCallback(() => options.streamCallbacks!.onCodexRateLimits!({
        rateLimits: rateLimits.rateLimits,
        snapshot: true,
        collectedAt: new Date(),
      }));
      await telemetryCallbacks;
    }
    if (activeThreadId) {
      const resumed = await request('thread/resume', {
        threadId: activeThreadId,
        cwd: runtimeCwd,
        sandbox: options.sandboxMode,
        approvalPolicy: options.approvalPolicy,
        config: { 'sandbox_workspace_write.network_access': options.networkAccess === 'enabled' },
        ...(options.model ? { model: options.model } : {}),
      });
      activeThreadId = resumed.thread?.id || activeThreadId;
    } else {
      const started = await request('thread/start', {
        cwd: runtimeCwd,
        sandbox: options.sandboxMode,
        approvalPolicy: options.approvalPolicy,
        config: { 'sandbox_workspace_write.network_access': options.networkAccess === 'enabled' },
        ephemeral: Boolean(options.ephemeral),
        ...(options.model ? { model: options.model } : {}),
      });
      activeThreadId = started.thread.id;
    }
    await options.onThreadStarted?.(activeThreadId!);
    turnSubmitted = true;
    await request('turn/start', {
      threadId: activeThreadId,
      input: [{ type: 'text', text: options.prompt }],
      cwd: runtimeCwd,
      approvalPolicy: options.approvalPolicy,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      summary: 'auto',
    });
    await turnDone;
    await telemetryCallbacks;
    return { output: output || 'Task executed successfully', threadId: activeThreadId!, turnId: activeTurnId };
  } catch (error) {
    throw new CodexAppServerError(
      error instanceof Error ? error.message : 'Codex app-server failed',
      !turnSubmitted && !child.killed
    );
  } finally {
    closed = true;
    clearSteering();
    rejectPending(new Error('Codex turn ended before receipt'));
    if (timeoutId) clearTimeout(timeoutId);
    control.kill('SIGTERM');
  }
};
