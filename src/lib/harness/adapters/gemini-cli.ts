import type { HarnessAdapter } from '../types';
import { executeGeminiTask, getGeminiVersion, isGeminiAvailable, resumeGeminiSession } from '@/lib/real-agents/gemini-cli-agent';

const INVALID_GEMINI_CONTINUATION_PATTERNS = [
  /Invalid session identifier/i,
  /Error resuming session/i,
  /Use --list-sessions/i,
];

export const geminiCliHarnessAdapter: HarnessAdapter = {
  type: 'gemini-cli',
  displayName: 'Gemini CLI',

  async checkAvailability() {
    const available = await isGeminiAvailable();
    return {
      available,
      version: available ? await getGeminiVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const result = await executeGeminiTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onSessionStarted: (sessionId) => {
        context.onSessionStarted?.({
          sessionId,
          sessionKind: 'gemini_session',
        });
      },
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionId,
      sessionKind: result.sessionId ? 'gemini_session' : undefined,
      liveStreaming: true,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const result = await resumeGeminiSession({
      sessionId,
      prompt: continuationMessage,
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onSessionStarted: (nextSessionId) => {
        context.onSessionStarted?.({
          sessionId: nextSessionId,
          sessionKind: 'gemini_session',
        });
      },
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionId,
      sessionKind: result.sessionId ? 'gemini_session' : undefined,
      liveStreaming: true,
    };
  },

  getCapabilities(executionBackend) {
    if (executionBackend === 'platform_local') {
      return {
        supportsQueuedUserMessages: true,
        supportsImmediateInterrupt: true,
        supportsResumeAfterInterrupt: true,
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
        summary: '当前 Gemini 先使用固定的非交互 headless 启动参数；ACPX 权限设置会记录到 run metadata，但还没有和 Gemini CLI 的 sandbox/approval 语义做精确映射。',
        sandboxMode: 'recorded_only',
        approvalPolicy: 'recorded_only',
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
    const sessionId =
      typeof metadata.lastSessionId === 'string' && metadata.lastSessionId.trim()
        ? metadata.lastSessionId.trim()
        : typeof metadata.geminiSessionId === 'string' && metadata.geminiSessionId.trim()
        ? metadata.geminiSessionId.trim()
        : null;

    return {
      sessionId,
      sessionKind: sessionId ? 'gemini_session' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_GEMINI_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
};
