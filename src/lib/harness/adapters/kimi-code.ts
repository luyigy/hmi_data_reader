import type { HarnessAdapter } from '../types';

async function loadKimiCodeAgent() {
  return import('@/lib/real-agents/kimi-code-agent');
}

const INVALID_KIMI_CONTINUATION_PATTERNS = [
  /Session ".+" not found\./i,
  /Session ".+" was created under a different directory\./i,
];

export const kimiCodeHarnessAdapter: HarnessAdapter = {
  type: 'kimi-code',
  displayName: 'Kimi Code CLI',

  async checkAvailability() {
    const { isKimiCodeAvailable, getKimiCodeVersion } = await loadKimiCodeAgent();
    const available = await isKimiCodeAvailable();
    return {
      available,
      version: available ? await getKimiCodeVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    if (context.executionBackend !== 'platform_local') {
      return {
        success: false,
        error: 'Kimi Code is only supported by platform_local.',
        executionTime: 0,
      };
    }
    const { executeKimiCodeTask: runKimiCode } = await loadKimiCodeAgent();
    const result = await runKimiCode(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      permissionProfile: context.permissionConfig?.profile,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      model: context.model,
    });
    return {
      ...result,
      sessionKind: result.sessionId ? 'kimi_session' : undefined,
      liveStreaming: true,
    };
  },

  async resume({ task, context, sessionId, continuationMessage }) {
    const { executeKimiCodeTask: resumeKimiCode } = await loadKimiCodeAgent();
    const result = await resumeKimiCode(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      networkAccess: context.networkAccess,
      permissionProfile: context.permissionConfig?.profile,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      model: context.model,
      prompt: continuationMessage,
      sessionId,
    });
    return {
      ...result,
      sessionKind: result.sessionId ? 'kimi_session' : undefined,
      liveStreaming: true,
    };
  },

  getCapabilities(executionBackend) {
    const local = executionBackend === 'platform_local';
    return {
      supportsQueuedUserMessages: local,
      supportsImmediateInterrupt: local,
      supportsResumeAfterInterrupt: local,
      supportsLiveSessionControl: false,
      supportsSoftStop: local,
    };
  },

  getPermissionSupport(executionBackend) {
    const local = executionBackend === 'platform_local';
    return {
      scope: 'next_run_or_continuation',
      hotReloadSupported: false,
      summary: local
        ? 'Kimi Code 受限模式使用 Bubblewrap；full access 才直接运行。CLI 审批模式在启动时映射。'
        : 'Kimi Code 当前仅接入 platform-local 执行。',
      sandboxMode: local ? 'applied' : 'recorded_only',
      approvalPolicy: local ? 'partially_applied' : 'recorded_only',
      networkAccess: local ? 'applied' : 'recorded_only',
      writableRoots: local ? 'applied' : 'recorded_only',
    };
  },

  readContinuation(metadata) {
    const sessionId =
      typeof metadata.lastSessionId === 'string' && metadata.lastSessionId.trim()
        ? metadata.lastSessionId.trim()
        : null;
    return {
      sessionId,
      sessionKind: sessionId ? 'kimi_session' : null,
    };
  },

  isInvalidContinuationError(message) {
    return INVALID_KIMI_CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  },
};
