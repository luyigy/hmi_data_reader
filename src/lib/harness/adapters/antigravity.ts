import type { HarnessAdapter } from '../types';
import {
  executeAntigravityTask,
  getAntigravityVersion,
  isAntigravityAvailable,
} from '@/lib/real-agents/antigravity-agent';

export const antigravityHarnessAdapter: HarnessAdapter = {
  type: 'antigravity',
  displayName: 'Antigravity CLI',

  async checkAvailability() {
    const available = await isAntigravityAvailable();
    return {
      available,
      version: available ? await getAntigravityVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const result = await executeAntigravityTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      onSpawn: context.onSpawn,
    });

    return {
      ...result,
      liveStreaming: true,
    };
  },

  getCapabilities(executionBackend) {
    return {
      supportsQueuedUserMessages: false,
      supportsImmediateInterrupt: executionBackend === 'platform_local',
      supportsResumeAfterInterrupt: false,
      supportsLiveSessionControl: false,
      supportsSoftStop: executionBackend === 'platform_local',
    };
  },

  getPermissionSupport(executionBackend) {
    const local = executionBackend === 'platform_local';
    return {
      scope: 'next_run_or_continuation',
      hotReloadSupported: false,
      summary: local
        ? 'Antigravity 使用 print 模式；普通配置启用 --sandbox，full access 使用 --dangerously-skip-permissions。'
        : 'Antigravity 当前仅接入 platform-local 执行。',
      sandboxMode: local ? 'applied' : 'recorded_only',
      approvalPolicy: local ? 'partially_applied' : 'recorded_only',
      networkAccess: 'recorded_only',
      writableRoots: 'recorded_only',
    };
  },
};
