import { withSessionSizeAdapter } from '../session-size';
import { readAntigravitySessionBytes } from '../../real-agents/session-size-readers';
import type { HarnessAdapter, HarnessExecuteArgs, NormalizedContextUsage } from '../types';

const ANTIGRAVITY_COMPLETION_CONTRACT = `Antigravity completion contract:
- A progress update or promise to report later is not a final response.
- Before ending, wait for every command and check you started, or report a concrete blocker.
- Return one self-contained final response that consolidates the relevant completed work and results from this turn and the recent transcript. Explicitly state whether the task completed, failed, or is blocked, plus any modified files and issues encountered.`;

async function loadAntigravityAgent() {
  return import('@/lib/real-agents/antigravity-agent');
}

async function run({ task, context }: HarnessExecuteArgs, sessionId?: string, prompt?: string) {
  const { executeAntigravityTask } = await loadAntigravityAgent();
  const result = await executeAntigravityTask(task, {
    timeout: context.timeout,
    sessionId,
    prompt,
    systemPrompt: ANTIGRAVITY_COMPLETION_CONTRACT,
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
    executionId: context.executionId,
  });

  const usage = result.contextUsage;
  const contextUsage: NormalizedContextUsage | undefined = usage ? {
    usedTokens: usage.lastRunInputTokens,
    model: usage.modelAlias || result.runtimeState?.model,
    outputTokens: usage.outputTokens,
    contextWindow: usage.contextWindow ?? undefined,
    metricKind: 'cumulative',
    confidence: usage.confidence ?? 'assumed_window',
    sessionId: result.sessionId,
    collectedAt: Date.parse(usage.updatedAt),
  } : undefined;
  return {
    ...result,
    contextUsage,
    runtimeState: result.runtimeState,
    sessionKind: result.sessionId ? 'antigravity_conversation' : undefined,
    liveStreaming: true,
  };
}

export const antigravityHarnessAdapter: HarnessAdapter = withSessionSizeAdapter({
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
      supportsResumeAfterInterrupt: executionBackend === 'platform_local',
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
}, { read: id => readAntigravitySessionBytes(id) });
