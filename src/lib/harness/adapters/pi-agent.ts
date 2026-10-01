import type { HarnessAdapter } from '../types';

async function loadPiAgent() {
  return import('@/lib/real-agents/pi-agent');
}

const INVALID_PI_CONTINUATION_PATTERNS = [
  /No session found/i,
  /No saved sessions/i,
  /session.*not found/i,
  /Stored session working directory does not exist/i,
];

export const piAgentHarnessAdapter: HarnessAdapter = {
  type: 'pi-agent',
  displayName: 'Pi Agent',

  async checkAvailability() {
    const { isPiAgentAvailable, getPiAgentVersion } = await loadPiAgent();
    const available = await isPiAgentAvailable();
    return {
      available,
      version: available ? await getPiAgentVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const { executePiAgentTask, resolvePiAgentSessionDir } = await loadPiAgent();
    const sessionDir = resolvePiAgentSessionDir(context.sessionKey || `${context.executionBackend}:${task.id}`);
    context.onSessionStarted?.({
      sessionId: sessionDir,
      sessionKind: 'pi_session_dir',
    });

    const result = await executePiAgentTask(task, {
      timeout: context.timeout,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      sessionDir,
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionDir,
      sessionKind: result.sessionDir ? 'pi_session_dir' : undefined,
      liveStreaming: false,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const { resumePiAgentSession } = await loadPiAgent();
    const result = await resumePiAgentSession({
      sessionDir: sessionId,
      prompt: continuationMessage,
      timeout: context.timeout,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionDir,
      sessionKind: result.sessionDir ? 'pi_session_dir' : undefined,
      liveStreaming: false,
    };
  },

  getCapabilities(executionBackend) {
    if (executionBackend === 'platform_local') {
      return {
        supportsQueuedUserMessages: true,
        supportsImmediateInterrupt: false,
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
        supportsImmediateInterrupt: false,
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

  getPermissionSupport() {
    return {
      scope: 'next_run_or_continuation',
      hotReloadSupported: false,
      summary: '当前 Pi Agent 以 print 模式接入；ACPX 权限会影响工具集合和会话目录，但还没有与 Pi 内部权限/审批语义做精确映射。',
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
        : typeof metadata.piSessionDir === 'string' && metadata.piSessionDir.trim()
        ? metadata.piSessionDir.trim()
        : null;

    return {
      sessionId,
      sessionKind: sessionId ? 'pi_session_dir' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_PI_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
};
