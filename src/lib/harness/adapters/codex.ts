import type { HarnessAdapter } from '../types';
import { executeCodexTask, getCodexVersion, isCodexAvailable, resumeCodexSession } from '@/lib/real-agents/codex-agent';

const INVALID_CODEX_CONTINUATION_PATTERNS = [
  /(session|thread|conversation).*(not found|does not exist|invalid)/i,
  /resume.*(failed|error)/i,
  /stream disconnected/i,
  /connection.*closed/i,
  /timed out after \d+ms/i,
  /timeout waiting for child process to exit/i,
  /failed to refresh available models/i,
];

export const codexHarnessAdapter: HarnessAdapter = {
  type: 'codex',
  displayName: 'Codex',

  async checkAvailability() {
    const available = await isCodexAvailable();
    return {
      available,
      version: available ? await getCodexVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const result = await executeCodexTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      ephemeral: context.ephemeralSession,
      codexHome: context.codexHome,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      onSpawn: context.onSpawn,
      onThreadStarted: (threadId) => {
        context.onSessionStarted?.({
          sessionId: threadId,
          sessionKind: 'codex_thread',
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
      sessionKind: result.threadId ? 'codex_thread' : undefined,
      threadId: result.threadId,
      liveStreaming: true,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const startTime = Date.now();

    try {
      const result = await resumeCodexSession({
        threadId: sessionId,
        prompt: continuationMessage,
        timeout: context.timeout,
        workingDirectory: context.workingDirectory,
        codexHome: context.codexHome,
        streamCallbacks: context.streamCallbacks,
        sandboxMode: context.permissionConfig?.sandboxMode,
        approvalPolicy: context.permissionConfig?.approvalPolicy,
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        onSpawn: context.onSpawn,
        onThreadStarted: (threadId) => {
          context.onSessionStarted?.({
            sessionId: threadId,
            sessionKind: 'codex_thread',
            threadId,
          });
        },
      });

      return {
        success: true,
        output: result.output,
        executionTime: Date.now() - startTime,
        filesModified: [],
        sessionId: result.threadId ?? undefined,
        sessionKind: result.threadId ? 'codex_thread' : undefined,
        threadId: result.threadId ?? undefined,
        liveStreaming: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
        liveStreaming: true,
      };
    }
  },

  getCapabilities(executionBackend) {
    if (executionBackend === 'platform_local') {
      return {
        supportsQueuedUserMessages: true,
        supportsImmediateInterrupt: true,
        supportsResumeAfterInterrupt: true,
        supportsLiveSessionControl: true,
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
        supportsResumeAfterInterrupt: true,
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
        summary: '当前会真实应用 sandbox；approval 会尽量映射到现有 Codex CLI；network 和 writable roots 先记录到 run metadata。',
        sandboxMode: 'applied',
        approvalPolicy: 'partially_applied',
        networkAccess: 'recorded_only',
        writableRoots: 'recorded_only',
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
    const threadId =
      typeof metadata.lastSessionId === 'string' && metadata.lastSessionId.trim()
        ? metadata.lastSessionId.trim()
        : typeof metadata.codexThreadId === 'string' && metadata.codexThreadId.trim()
        ? metadata.codexThreadId.trim()
        : typeof metadata.lastSessionThreadId === 'string' && metadata.lastSessionThreadId.trim()
        ? metadata.lastSessionThreadId.trim()
        : null;

    return {
      sessionId: threadId,
      sessionKind: threadId ? 'codex_thread' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_CODEX_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
};
