import type { HarnessAdapter } from '../types';
import { executeClaudeTask, getClaudeVersion, isClaudeAvailable, resumeClaudeSession } from '@/lib/real-agents/claude-agent';

const INVALID_CLAUDE_CONTINUATION_PATTERNS = [
  /No conversation found with session ID/i,
  /403.*forbidden|forbidden.*403|Request not allowed/i,
  /Failed to authenticate/i,
];

const buildClaudeAdapter = (harnessType: 'claude' | 'claude-haha', displayName: string): HarnessAdapter => ({
  type: harnessType,
  displayName,

  async checkAvailability() {
    const available = await isClaudeAvailable(harnessType);
    return {
      available,
      version: available ? await getClaudeVersion(harnessType) : undefined,
    };
  },

  async execute({ task, context }) {
    const result = await executeClaudeTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      harnessType,
      onSessionStarted: (sessionId) => {
        context.onSessionStarted?.({
          sessionId,
          sessionKind: 'claude_session',
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
      sessionKind: result.sessionId ? 'claude_session' : undefined,
      liveStreaming: true,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const result = await resumeClaudeSession({
      sessionId,
      prompt: continuationMessage,
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      harnessType,
      onSessionStarted: (nextSessionId) => {
        context.onSessionStarted?.({
          sessionId: nextSessionId,
          sessionKind: 'claude_session',
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
      sessionKind: result.sessionId ? 'claude_session' : undefined,
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

  getPermissionSupport() {
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
        : typeof metadata.claudeSessionId === 'string' && metadata.claudeSessionId.trim()
        ? metadata.claudeSessionId.trim()
        : null;

    return {
      sessionId,
      sessionKind: sessionId ? 'claude_session' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_CLAUDE_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
});

export const claudeHarnessAdapter = buildClaudeAdapter('claude', 'Claude');
export const claudeHahaHarnessAdapter = buildClaudeAdapter('claude-haha', 'Claude Haha');
