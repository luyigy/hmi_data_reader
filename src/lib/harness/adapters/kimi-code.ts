import path from 'node:path';
import type { HarnessAdapter, HarnessExecuteArgs } from '../types';

import { collectKimiCodeSessionTelemetry } from '@/lib/real-agents/kimi-code-telemetry';

const collectTelemetry = (sessionId: string | undefined, context: HarnessExecuteArgs['context'], startedAt: number) =>
  sessionId && context.executionId
    ? collectKimiCodeSessionTelemetry({ sessionId, executionId: context.executionId,
      startedAt, completedAt: Date.now(), home: context.runtimeHome ? path.join(context.runtimeHome, '.kimi-code') : undefined }) : undefined;

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
    const startedAt = Date.now();
    const { executeKimiCodeTask: runKimiCode } = await loadKimiCodeAgent();
    const result = await runKimiCode(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      extraWritableRoots: context.extraWritableRoots,
      extraReadOnlyPaths: context.extraReadOnlyPaths,
      networkAccess: context.networkAccess,
      sandboxMode: context.permissionConfig?.sandboxMode,
      permissionProfile: context.permissionConfig?.profile,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      model: context.model,
      runtimeHome: context.runtimeHome,
    });
    if (result.sessionId) {
      await context.onSessionStarted?.({ sessionId: result.sessionId, sessionKind: 'kimi_session' });
    }
    const telemetry = result.success ? await collectTelemetry(result.sessionId, context, startedAt) : undefined;
    return {
      ...result,
      contextUsage: telemetry?.contextUsage,
      runtimeState: telemetry?.runtimeState,
      sessionKind: result.sessionId ? 'kimi_session' : undefined,
      liveStreaming: true,
    };
  },

  async resume({ task, context, sessionId, continuationMessage }) {
    const startedAt = Date.now();
    const { executeKimiCodeTask: resumeKimiCode } = await loadKimiCodeAgent();
    const result = await resumeKimiCode(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      extraWritableRoots: context.extraWritableRoots,
      extraReadOnlyPaths: context.extraReadOnlyPaths,
      networkAccess: context.networkAccess,
      sandboxMode: context.permissionConfig?.sandboxMode,
      permissionProfile: context.permissionConfig?.profile,
      streamCallbacks: context.streamCallbacks,
      onSpawn: context.onSpawn,
      model: context.model,
      runtimeHome: context.runtimeHome,
      prompt: continuationMessage,
      sessionId,
    });
    if (result.sessionId) {
      await context.onSessionStarted?.({ sessionId: result.sessionId, sessionKind: 'kimi_session' });
    }
    const telemetry = result.success ? await collectTelemetry(result.sessionId, context, startedAt) : undefined;
    return {
      ...result,
      contextUsage: telemetry?.contextUsage,
      runtimeState: telemetry?.runtimeState,
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
