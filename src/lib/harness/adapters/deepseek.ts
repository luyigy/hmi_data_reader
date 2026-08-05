import type { HarnessAdapter } from '../types';

async function loadDeepSeekAgent() {
  return import('@/lib/real-agents/deepseek-agent');
}

const INVALID_DEEPSEEK_CONTINUATION_PATTERNS = [
  /thread not found/i,
  /turn .* failed/i,
];

export const deepSeekHarnessAdapter: HarnessAdapter = {
  type: 'deepseek',
  displayName: 'DeepSeek',

  async checkAvailability() {
    const { isDeepSeekAvailable, getDeepSeekVersion } = await loadDeepSeekAgent();
    const available = await isDeepSeekAvailable();
    return {
      available,
      version: available ? await getDeepSeekVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const { executeDeepSeekTask } = await loadDeepSeekAgent();
    const result = await executeDeepSeekTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onThreadStarted: (threadId) => {
        context.onSessionStarted?.({
          sessionId: threadId,
          sessionKind: 'deepseek_thread',
          threadId,
        });
      },
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.threadId,
      sessionKind: result.threadId ? 'deepseek_thread' : undefined,
      threadId: result.threadId,
      liveStreaming: false,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const { resumeDeepSeekSession } = await loadDeepSeekAgent();
    const result = await resumeDeepSeekSession({
      threadId: sessionId,
      prompt: continuationMessage,
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onThreadStarted: (threadId) => {
        context.onSessionStarted?.({
          sessionId: threadId,
          sessionKind: 'deepseek_thread',
          threadId,
        });
      },
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.threadId,
      sessionKind: result.threadId ? 'deepseek_thread' : undefined,
      threadId: result.threadId,
      liveStreaming: false,
    };
  },

  getCapabilities(executionBackend) {
    if (executionBackend === 'platform_local') {
      return {
        supportsQueuedUserMessages: false,
        supportsImmediateInterrupt: false,
        supportsResumeAfterInterrupt: false,
        supportsLiveSessionControl: false,
        supportsSoftStop: true,
      };
    }

    if (executionBackend === 'gateway_openclaw') {
      return {
        supportsQueuedUserMessages: true,
        supportsImmediateInterrupt: false,
        supportsResumeAfterInterrupt: false,
        supportsLiveSessionControl: false,
        supportsSoftStop: false,
      };
    }

    if (executionBackend === 'remote_ssh') {
      return {
        supportsQueuedUserMessages: true,
        supportsImmediateInterrupt: true,
        supportsResumeAfterInterrupt: false,
        supportsLiveSessionControl: false,
        supportsSoftStop: true,
      };
    }

    return {
      supportsQueuedUserMessages: false,
      supportsImmediateInterrupt: false,
      supportsResumeAfterInterrupt: false,
      supportsLiveSessionControl: false,
      supportsSoftStop: false,
    };
  },

  getPermissionSupport(executionBackend) {
    if (executionBackend === 'platform_local') {
      return {
        scope: 'next_run_or_continuation',
        hotReloadSupported: false,
        summary: '当前会在新建 DeepSeek thread 时映射 shell/auto-approve 权限；受限运行由 Bubblewrap 强制工作区和网络边界。',
        sandboxMode: 'applied',
        approvalPolicy: 'partially_applied',
        networkAccess: 'applied',
        writableRoots: 'applied',
      };
    }

    return {
      scope: 'next_run_or_continuation',
      hotReloadSupported: false,
      summary: '当前这类 harness 还没有接入 launch-time 权限下发；设置会先记录到 run metadata，供后续能力对齐。',
      sandboxMode: 'recorded_only',
      approvalPolicy: 'recorded_only',
      networkAccess: 'recorded_only',
      writableRoots: 'recorded_only',
    };
  },

  readContinuation(metadata) {
    const sessionId =
      typeof metadata.lastSessionId === 'string' && metadata.lastSessionId.trim()
        ? metadata.lastSessionId.trim()
        : typeof metadata.deepseekThreadId === 'string' && metadata.deepseekThreadId.trim()
        ? metadata.deepseekThreadId.trim()
        : null;

    return {
      sessionId,
      sessionKind: sessionId ? 'deepseek_thread' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_DEEPSEEK_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
};
