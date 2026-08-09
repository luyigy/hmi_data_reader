import type { ChildProcess } from 'child_process';
import { updateCodexQuotaCache } from '@/lib/codex-telemetry';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { getHarnessAdapter } from '@/lib/harness';
import { resolvePlatformLocalCodexHome } from '@/lib/real-agents/codex-home';
import {
  collectKimiCodeProviderContextUsage,
  persistKimiCodeContextUsageMetadata,
} from '@/lib/real-agents/kimi-code-telemetry';
import { persistAntigravityContextUsageMetadata } from '@/lib/real-agents/antigravity-context';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { executeRemoteSshTask } from '@/lib/remote-harness/ssh-executor';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from './permissions';
import { registerRunningProcess } from './process-registry';
import { getParticipantContinuationKey } from './session-tracking';
import { persistPlatformLocalSessionMetadata } from './runner-metadata';
import { buildHarnessPrompt, withLongFileRuntimeContext } from './prompt';
import type { LongFileRuntimeContext } from './long-file-runtime-context';
import type { AcpxParticipantRequest, AcpxRunRequest, HarnessStreamCallbacks } from './types';

const DEFAULT_LOCAL_HARNESS_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS = 10 * 60 * 1000;

export const resolveHarnessTimeout = (
  configuredTimeout: number | null | undefined,
  defaultTimeout: number
): number | null =>
  configuredTimeout === null
    ? null
    : typeof configuredTimeout === 'number'
    ? configuredTimeout
    : defaultTimeout;

export const executeViaGateway = async (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  contextWarning?: string | null
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const config = await getOpenClawGatewayConfig(participant.gatewayId);

  if (!config) {
    throw new Error(`Gateway "${participant.gatewayName || participant.gatewayId}" 未配置 OpenClaw`);
  }

  const response = await createOpenClawResponse(config, {
    input: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
    agentId: participant.agentId,
    model: participant.agentId ? `openclaw:${participant.agentId}` : undefined,
    sessionKey: `task:${request.taskId}:gateway:${participant.gatewayId}`,
  });

  return {
    output: extractOpenClawText(response) || JSON.stringify(response, null, 2),
    filesModified: [] as string[],
    executionTime: 0,
    liveStreaming: false,
    threadId: undefined,
  };
};
export const executeViaLocalHarness = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  callbacks: HarnessStreamCallbacks,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  onSpawn?: (child: { pid?: number }) => void, contextWarning?: string | null, longFileContext?: LongFileRuntimeContext | null,
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const task = {
    id: request.taskId,
    name: request.taskName,
    description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning, longFileContext),
  };
  const adapter = getHarnessAdapter(participant.harnessType);
  if (!adapter) {
    throw new Error(`本地暂不支持 harness: ${participant.harnessType}`);
  }
  const permissionConfig = request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG;
  const workspaceRoot = permissionConfig.profile === 'full_access'
    ? undefined
    : permissionConfig.writableRoots[0] || request.workingDirectory || process.cwd();
  const codexHome = participant.harnessType === 'codex'
    ? resolvePlatformLocalCodexHome(workspaceRoot, participant.codexHome)
    : participant.codexHome;
  const harnessCallbacks = participant.harnessType === 'codex'
    ? {
        ...callbacks,
        onCodexRateLimits: (event: Parameters<NonNullable<HarnessStreamCallbacks['onCodexRateLimits']>>[0]) => {
          updateCodexQuotaCache({ codexHome, ...event });
        },
      }
    : callbacks;
  if (workspaceRoot && !['codex', 'claude', 'claude-haha', 'kimi-code', 'antigravity', 'deepseek', 'pi-agent'].includes(participant.harnessType)) {
    throw new Error(`受限 Feishu 工作区暂不支持 harness: ${participant.harnessType}`);
  }
  const registerSpawn = (child: ChildProcess) => {
    registerRunningProcess({
      taskRunId,
      participantId,
      child,
      executionBackend: participant.executionBackend,
      harnessType: participant.harnessType,
    });
    onSpawn?.(child);
  };

  const result = participant.continuationMessage && adapter.resume && (participant.resumeSessionId || participant.resumeThreadId)
    ? await adapter.resume({
        task,
        sessionId: participant.resumeSessionId || participant.resumeThreadId || '',
        continuationMessage: withLongFileRuntimeContext(participant.continuationMessage, longFileContext),
        context: {
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          networkAccess: permissionConfig.networkAccess,
          executionBackend: participant.executionBackend,
          permissionConfig,
          timeout: resolveHarnessTimeout(
            request.watchdogConfig?.maxRuntimeMs,
            DEFAULT_LOCAL_HARNESS_MAX_RUNTIME_MS
          ),
          ephemeralSession: participant.ephemeralSession,
          codexHome,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          sessionKey: getParticipantContinuationKey({
            continuationKey: participant.continuationKey,
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }),
          streamCallbacks: harnessCallbacks,
          onSpawn: registerSpawn,
          onSessionStarted: (session) =>
            persistPlatformLocalSessionMetadata(
              taskRunId,
              participantId,
              session.sessionKind,
              session.sessionId,
              session.threadId
            ),
        },
      })
    : await adapter.execute({
        task,
        context: {
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          networkAccess: permissionConfig.networkAccess,
          executionBackend: participant.executionBackend,
          permissionConfig,
          timeout: resolveHarnessTimeout(
            request.watchdogConfig?.maxRuntimeMs,
            DEFAULT_LOCAL_HARNESS_MAX_RUNTIME_MS
          ),
          ephemeralSession: participant.ephemeralSession,
          codexHome,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          sessionKey: getParticipantContinuationKey({
            continuationKey: participant.continuationKey,
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }),
          streamCallbacks: harnessCallbacks,
          onSpawn: registerSpawn,
          onSessionStarted: (session) =>
            persistPlatformLocalSessionMetadata(
              taskRunId,
              participantId,
              session.sessionKind,
              session.sessionId,
              session.threadId
            ),
        },
      });

  if (!result.success) {
    throw new Error(result.error || `${adapter.displayName} execution failed`);
  }
  if (participant.harnessType === 'kimi-code' && result.sessionId) {
    try {
      const usage = await collectKimiCodeProviderContextUsage({
        sessionId: result.sessionId,
      });
      if (usage) {
        await persistKimiCodeContextUsageMetadata(participantId, usage);
      }
    } catch {
      // Context telemetry is diagnostic and must not turn a successful Kimi run into a failure.
    }
  }
  if (participant.harnessType === 'antigravity' && result.contextUsage) {
    try {
      await persistAntigravityContextUsageMetadata(participantId, result.contextUsage);
    } catch {
      // Context telemetry is diagnostic and must not turn a successful Antigravity run into a failure.
    }
  }

  return {
    output: result.output || `${adapter.displayName} completed`,
    filesModified: result.filesModified ?? [],
    executionTime: result.executionTime,
    liveStreaming: result.liveStreaming ?? false,
    sessionId: result.sessionId,
    sessionKind: result.sessionKind,
    threadId: result.threadId,
  };
};

export const executeViaRemoteSshHarness = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  callbacks: HarnessStreamCallbacks,
  previousSummaries: string[],
  taskRoomContext: {
    transcript: string;
    latestUserMessage: {
      id: string;
      content: string;
      createdAt: string;
      targetType: string;
      targetParticipantLabel: string | null;
    } | null;
  },
  onSpawn?: (child: { pid?: number }) => void,
  contextWarning?: string | null
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const remoteHost = await getRemoteHarnessHostById(participant.gatewayId);

  if (!remoteHost) {
    throw new Error(`Remote SSH host not found: ${participant.gatewayId}`);
  }

  if (!remoteHost.supportedHarnesses.includes(participant.harnessType.toLowerCase())) {
    throw new Error(
      `Remote SSH host "${remoteHost.label}" does not declare harness "${participant.harnessType}"`
    );
  }

  return executeRemoteSshTask(
    {
      id: request.taskId,
      name: request.taskName,
      description: buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
    },
    {
      timeout: resolveHarnessTimeout(
        request.watchdogConfig?.maxRuntimeMs,
        DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS
      ) ?? DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS,
      harnessType: participant.harnessType,
      host: remoteHost,
      resumeSessionId: participant.resumeSessionId || participant.resumeThreadId,
      continuationMessage: participant.resumeSessionId ? participant.continuationMessage : undefined,
      model: participant.model,
      reasoningEffort: participant.reasoningEffort,
      streamCallbacks: callbacks,
      onSpawn: (child) => {
        registerRunningProcess({
          taskRunId,
          participantId,
          child,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
        });
        onSpawn?.(child);
      },
    }
  );
};
