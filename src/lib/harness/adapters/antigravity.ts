import type { HarnessAdapter, HarnessExecuteArgs } from '../types';

async function loadAntigravityAgent() {
  return import('@/lib/real-agents/antigravity-agent');
}

async function run({ task, context }: HarnessExecuteArgs, sessionId?: string, prompt?: string) {
  const { executeAntigravityTask } = await loadAntigravityAgent();
  const result = await executeAntigravityTask(task, {
    timeout: context.timeout,
    sessionId,
    prompt,
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    onSessionStarted: (id) => context.onSessionStarted?.({ sessionId: id, sessionKind: 'antigravity_conversation' }),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    extraWritableRoots: context.extraWritableRoots,
    extraReadOnlyPaths: context.extraReadOnlyPaths,
    networkAccess: context.networkAccess,
    streamCallbacks: context.streamCallbacks,
    sandboxMode: context.permissionConfig?.sandboxMode,
    onSpawn: context.onSpawn,
  });

  return {
    ...result,
    sessionKind: result.sessionId ? 'antigravity_conversation' : undefined,
    liveStreaming: true,
  };
}

export const antigravityHarnessAdapter: HarnessAdapter = {
  type: 'antigravity',
  displayName: 'Antigravity CLI',

  async checkAvailability() {
    const { isAntigravityAvailable, getAntigravityVersion } = await loadAntigravityAgent();
    const available = await isAntigravityAvailable();
    return {
      available,
      version: available ? await getAntigravityVersion() : undefined,
    };
  },

  execute: run,

  resume(args) {
    return run(args, args.sessionId, args.continuationMessage);
  },

  getCapabilities(executionBackend) {
    return {
      supportsQueuedUserMessages: executionBackend === 'platform_local',
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
        ? 'Antigravity 使用 print 模式；受限运行由 Bubblewrap 强制工作区和网络边界，full access 使用 --dangerously-skip-permissions。'
        : 'Antigravity 当前仅接入 platform-local 执行。',
      sandboxMode: local ? 'applied' : 'recorded_only',
      approvalPolicy: local ? 'partially_applied' : 'recorded_only',
      networkAccess: local ? 'applied' : 'recorded_only',
      writableRoots: local ? 'applied' : 'recorded_only',
    };
  },
};
