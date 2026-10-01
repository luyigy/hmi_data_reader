import type { HarnessAdapter, HarnessExecutionContext, NormalizedContextUsage } from '../types';
import { homedir } from 'node:os';
import path from 'node:path';
import { SHARED_ENTRIES } from '@/lib/real-agents/codex-home';
import { resolveWorkflowCodexBoundary } from '@/lib/workflow-execution-policy';

// Keep the native stream callback at the protocol boundary.
function contextTelemetry(context: HarnessExecutionContext) {
  let latest: NormalizedContextUsage | undefined;
  return {
    get usage() { return latest; },
    callbacks: {
      ...context.streamCallbacks,
      onCodexTokenUsage: async (usage: import('@/lib/codex-telemetry').CodexProviderTokenUsage) => {
        const next: NormalizedContextUsage = {
          usedTokens: usage.last.inputTokens,
          contextWindow: usage.modelContextWindow,
          metricKind: 'turn_input',
          confidence: 'measured_exact',
          sessionId: usage.threadId,
          collectedAt: Date.parse(usage.collectedAt),
        };
        if (!latest || next.collectedAt >= latest.collectedAt) {
          latest = next;
          await context.onContextUsage?.(next);
        }
        await context.streamCallbacks?.onCodexTokenUsage?.(usage);
      },
    },
  };
}

// Explicit mounts replace automatic config symlink discovery in Bubblewrap.
const codexReadOnlyPaths = (extra?: string[]) => extra?.length
  ? [...SHARED_ENTRIES.map((entry) => path.join(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'), entry)), ...extra]
  : undefined;

async function loadCodexAgent() {
  return import('@/lib/real-agents/codex-agent');
}

const INVALID_CODEX_CONTINUATION_PATTERNS = [
  /(session|thread|conversation).*(not found|does not exist|invalid)/i,
  /resume.*(failed|error)/i,
  /stream disconnected/i,
  /connection.*closed/i,
  /failed to refresh available models/i,
];

export const codexHarnessAdapter: HarnessAdapter = {
  type: 'codex',
  displayName: 'Codex',

  async checkAvailability() {
    const { isCodexAvailable, getCodexVersion } = await loadCodexAgent();
    const available = await isCodexAvailable();
    return {
      available,
      version: available ? await getCodexVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const { executeCodexTask } = await loadCodexAgent();
    const telemetry = contextTelemetry(context);
    const workflowBoundary = resolveWorkflowCodexBoundary(
      context.permissionConfig,
      context.workingDirectory,
      context.codexHome,
    );
    const result = await executeCodexTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      extraWritableRoots: context.extraWritableRoots,
      readOnlyPaths: codexReadOnlyPaths(context.extraReadOnlyPaths),
      networkAccess: context.networkAccess,
      ephemeral: context.ephemeralSession,
      codexHome: context.codexHome,
      streamCallbacks: telemetry.callbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      onSpawn: context.onSpawn,
      ...workflowBoundary,
      onThreadStarted: (threadId) => {
        return context.onSessionStarted?.({
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
      contextUsage: telemetry.usage,
      liveStreaming: true,
    };
  },

  async resume({ context, sessionId, continuationMessage }) {
    const { resumeCodexSession } = await loadCodexAgent();
    const startTime = Date.now();
    const telemetry = contextTelemetry(context);
    const workflowBoundary = resolveWorkflowCodexBoundary(
      context.permissionConfig,
      context.workingDirectory,
      context.codexHome,
    );

    try {
      const result = await resumeCodexSession({
        threadId: sessionId,
        prompt: continuationMessage,
        timeout: context.timeout,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
        extraWritableRoots: context.extraWritableRoots,
        readOnlyPaths: codexReadOnlyPaths(context.extraReadOnlyPaths),
        networkAccess: context.networkAccess,
        codexHome: context.codexHome,
        streamCallbacks: telemetry.callbacks,
        sandboxMode: context.permissionConfig?.sandboxMode,
        approvalPolicy: context.permissionConfig?.approvalPolicy,
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        onSpawn: context.onSpawn,
        ...workflowBoundary,
        onThreadStarted: (threadId) => {
          return context.onSessionStarted?.({
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
        contextUsage: telemetry.usage,
        liveStreaming: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
        contextUsage: telemetry.usage,
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
        summary: 'Platform Local Codex 通过 Bubblewrap 应用 workspace、网络、隔离临时目录和只读配置例外；非交互 JSON 路径不请求普通运行时审批。',
        sandboxMode: 'applied',
        approvalPolicy: 'applied',
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
