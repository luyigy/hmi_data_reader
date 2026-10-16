import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';
import type { ChildProcess } from 'child_process';
import { updateCodexQuotaCache } from '@/lib/codex-telemetry';
import {
  createOpenClawResponse,
  extractOpenClawText,
  getOpenClawGatewayConfig,
} from '@/lib/openclaw-client';
import { getHarnessAdapter } from '@/lib/harness';
import { resolveLocalRuntimeReadOnlyPaths } from './runtime-environments';
import { resolvePlatformLocalCodexHome } from '@/lib/real-agents/codex-home';
import { persistContextUsage } from '@/lib/context-usage';
import { beginHarnessRuntimeExecution, persistHarnessRuntimeState } from '@/lib/harness-runtime-state';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { executeRemoteSshTask } from '@/lib/remote-harness/ssh-executor';
import { executeRemoteRunnerTask } from '@/lib/remote-harness/runner-executor';
import { getRemoteNodeWorkspace } from '@/lib/remote-node-registry';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from './permissions';
import { registerRunningProcess } from './process-registry';
import { getParticipantContinuationKey } from './session-tracking';
import { persistPlatformLocalSessionMetadata } from './runner-metadata';
import { buildHarnessPrompt, withFeishuBotContactInstructions, withLongFileRuntimeContext } from './prompt';
import type { LongFileRuntimeContext } from './long-file-runtime-context';
import type { AcpxParticipantRequest, AcpxRunRequest, HarnessStreamCallbacks } from './types';
import { DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS } from '@/lib/live-room-execution-timeout';

const DEFAULT_LOCAL_HARNESS_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS = DEFAULT_REMOTE_EXECUTION_TIMEOUT_MS;

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
  const extraWritableRoots = permissionConfig.profile === 'full_access'
    ? []
    : [...permissionConfig.writableRoots.slice(1), ...linkedWorktreeGitDirectories(workspaceRoot)].filter((root, index, all) => all.indexOf(root) === index);
  const extraReadOnlyPaths = resolveLocalRuntimeReadOnlyPaths(
    request.workingDirectory || process.cwd(), permissionConfig,
  );
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

  const runtimeExecution = await beginHarnessRuntimeExecution(participantId);
  let metadataWrites = Promise.resolve();
  let boundSessionId: string | undefined;
  const onSessionStarted = (session: import('@/lib/harness/types').HarnessSessionStarted) => {
    metadataWrites = metadataWrites.then(async () => {
      try {
        await persistPlatformLocalSessionMetadata(
          taskRunId, participantId, session.sessionKind, session.sessionId, session.threadId,
        );
        boundSessionId = session.threadId || session.sessionId;
      } catch {
        boundSessionId = undefined;
        console.warn('Runtime telemetry: could not bind session', participantId);
      }
    });
    return metadataWrites;
  };
  const onContextUsage = async (usage: import('@/lib/harness/types').NormalizedContextUsage) => {
    metadataWrites = metadataWrites.then(async () => {
      try { await persistContextUsage(participantId, usage); }
      catch { console.warn('Context telemetry: could not persist usage', participantId); }
    });
    await metadataWrites;
  };
  const result = participant.continuationMessage && adapter.resume && (participant.resumeSessionId || participant.resumeThreadId)
    ? await adapter.resume({
        task,
        sessionId: participant.resumeSessionId || participant.resumeThreadId || '',
        continuationMessage: withLongFileRuntimeContext(withFeishuBotContactInstructions(participant.continuationMessage), longFileContext),
        context: {
          executionId: runtimeExecution.id,
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          extraWritableRoots,
          extraReadOnlyPaths,
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
          onContextUsage,
          onSessionStarted,
        },
      })
    : await adapter.execute({
        task,
        context: {
          executionId: runtimeExecution.id,
          workingDirectory: request.workingDirectory || process.cwd(),
          workspaceRoot,
          extraWritableRoots,
          extraReadOnlyPaths,
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
          onContextUsage,
          onSessionStarted,
        },
      });

  await metadataWrites;
  if (result.runtimeState && result.sessionId && result.sessionKind) {
    await onSessionStarted({ sessionId: result.sessionId, sessionKind: result.sessionKind, threadId: result.threadId });
  }
  if (result.contextUsage) await onContextUsage(result.contextUsage);
  if (!result.success) {
    throw new Error(result.error || `${adapter.displayName} execution failed`);
  }

  if (result.runtimeState && result.runtimeState.sessionId === boundSessionId) {
    await persistHarnessRuntimeState(runtimeExecution, result.runtimeState);
  } else if (result.runtimeState) {
    console.warn('Runtime telemetry: missing current execution session binding', participantId);
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
  if (participant.gatewayId.startsWith('remote-node:')) {
    if (participant.harnessType !== 'pi-agent') {
      throw new Error(`Remote runner currently supports only pi-agent, received: ${participant.harnessType}`);
    }
    const nodeName = participant.gatewayId.slice('remote-node:'.length);
    const remoteWorkspace = await getRemoteNodeWorkspace(nodeName);
    if (!remoteWorkspace) throw new Error(`Remote runner has not announced a workspace: ${nodeName}`);
    return executeRemoteRunnerTask({
      nodeName,
      taskId: request.taskId,
      cwd: remoteWorkspace,
      prompt: participant.continuationMessage
        ? withFeishuBotContactInstructions(participant.continuationMessage)
        : buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning),
      sessionDir: participant.resumeSessionId || participant.resumeThreadId,
      continuation: Boolean(participant.continuationMessage && (participant.resumeSessionId || participant.resumeThreadId)),
      timeout: resolveHarnessTimeout(
        request.watchdogConfig?.maxRuntimeMs,
        DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS
      ) ?? DEFAULT_REMOTE_HARNESS_MAX_RUNTIME_MS,
      streamCallbacks: callbacks,
      onControl: (child) => {
        registerRunningProcess({
          taskRunId,
          participantId,
          child,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
        });
        onSpawn?.(child);
      },
    });
  }

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
      continuationMessage: participant.resumeSessionId && participant.continuationMessage
        ? withFeishuBotContactInstructions(participant.continuationMessage) : undefined,
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
