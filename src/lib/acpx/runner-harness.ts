import { normalizeSessionSize } from '../session-size';
import { graphResourceJobs } from '../task-graph/graph-association';
import { recordResourceMountPlan, recordResourceSession, ResourceApplicationError } from '../task-resources/mount-plan';
import { assertResourceUseActive, withResourceProcessGuard } from '../task-resources/process-guard';
import { resourceRequestInstructions, submitRunnerResourceRequest } from '../task-resources/runner-protocol';
import { AgentProtocolOutput } from '../agent-protocol-output';
import { resourcesForRun, markResourceRunEffective } from '../task-resources/runtime';
import type { HarnessExecutionContext, HarnessSandbox } from '../harness/types';
import { withSandbox, type ManagedProcessControl, type SandboxIdentity } from '../sandbox-manager';
import { withTaskProjectCapabilities } from '../project-capabilities/task-runtime';
import { prepareTaskDeclaredRuntime } from '../task-graph/runtime-continuity';
import { prepareGraphOutputForTask } from '../task-graph/output-task-context';
import { graphWriterEnvironment } from '../task-graph/writer-ownership';
import { withGraphTaskServices } from '../task-graph/graph-services';
import { graphInputsForTask } from '../task-graph/upstream-inputs';
import { graphValidationArchiveForTask } from '../task-graph/validation-archive-access';
import { graphMaterialPathsForTask } from '../task-graph/conversation-materials';
import { graphDependencyPaths } from '../task-graph/dependency-paths';
import { prepareGraphHarnessRuntime } from '../task-graph/harness-runtime';
import path from 'node:path';
import { prisma } from '../prisma';
import { existsSync } from 'node:fs';
import { agentCommitGitAccess } from '../task-graph/agent-commit';
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
import { beginHarnessRuntimeExecution, persistHarnessRuntimeState, persistSessionSize } from '@/lib/harness-runtime-state';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { executeRemoteSshTask } from '@/lib/remote-harness/ssh-executor';
import { executeRemoteRunnerTask } from '@/lib/remote-harness/runner-executor';
import { getRemoteNodeWorkspace } from '@/lib/remote-node-registry';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from './permissions';
import { registerRunningProcess } from './process-registry';
import { getParticipantContinuationKey } from './session-tracking';
import { persistPlatformLocalSessionMetadata } from './runner-metadata';
import { harnessContinuationInput, buildHarnessPrompt } from './prompt';
import { captureStageAuthority } from './stage-authority';
import { StageExecutionRequest } from './stage-execution-request';
import { executePreparedStageHarness, stageRuntimeContract } from './stage-harness-dispatch';
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
  onSpawn?: (child: { pid?: number; sandboxIdentity?: SandboxIdentity | null }) => void, contextWarning?: string | null, longFileContext?: LongFileRuntimeContext | null,
): Promise<{
  output: string;
  filesModified: string[];
  executionTime: number;
  liveStreaming: boolean;
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
}> => {
  const stageAuthority = await captureStageAuthority(request, taskRunId);
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
  const graphJobs = await graphResourceJobs(request.taskId);
  const isGraph = graphJobs.length > 0;
  const inputs = isGraph ? await graphInputsForTask(request.taskId, permissionConfig.sandboxMode === 'read-only', true) : null;
  const resourceAccess = await resourcesForRun({ ...request, participants: [participant] }, taskRunId, participantId, inputs?.manifests);
  task.description += (participant.harnessType === 'codex' ? resourceRequestInstructions : '') + resourceAccess.instructions;
  if (isGraph && request.workingDirectory && !existsSync(request.workingDirectory)) {
    throw new Error('任务工作区已清理或不可用。历史回复和提交仍保留；继续实施请创建后续任务工作区。');
  }
  if (permissionConfig.sandboxMode === 'read-only' && adapter.getPermissionSupport('platform_local').sandboxMode !== 'applied') {
    throw new Error(`${adapter.displayName} 尚不支持强制只读工作区，不能执行此验收角色。`);
  }
  const workspaceRoot = permissionConfig.profile === 'full_access'
    ? undefined
    : permissionConfig.writableRoots[0] || request.workingDirectory || process.cwd();
  const runtimeWorkspace = workspaceRoot || request.workingDirectory;
  const graphRuntime = isGraph
    ? prepareGraphHarnessRuntime(request.taskId, participant.harnessType) : null;
  if ((request.graphExecution || request.graphReview) && !workspaceRoot) throw new Error('任务图执行需要受限工作区，不能使用 full_access。');
  const agentGit = graphRuntime && permissionConfig.sandboxMode !== 'read-only' ? await agentCommitGitAccess(request.taskId, runtimeWorkspace) : null;
  const graphGit = agentGit ? agentGit.readonly : graphRuntime ? linkedWorktreeGitDirectories(runtimeWorkspace) : [];
  const extraWritableRoots = permissionConfig.profile === 'full_access' || permissionConfig.sandboxMode === 'read-only'
    ? []
    : [...permissionConfig.writableRoots.slice(1), ...(graphRuntime ? [] : linkedWorktreeGitDirectories(workspaceRoot))].filter((root, index, all) => all.indexOf(root) === index);
  if (agentGit) extraWritableRoots.push(...agentGit.writable);
  extraWritableRoots.push(...resourceAccess.write);
  if (inputs) { task.description += inputs.instructions; extraWritableRoots.push(...inputs.writablePaths); }
  const outputWorkspaces = graphJobs.some(job => job.childTaskId === request.taskId)
    ? request.workingDirectory ? [request.workingDirectory] : []
    : graphJobs.flatMap(job => job.worktreePath ? [job.worktreePath] : []);
  const output = graphRuntime ? await prepareGraphOutputForTask(request.taskId, `harness:${taskRunId}:${participantId}`, outputWorkspaces) : null;
  if (output) task.description += output.instructions;
  const validationArchive = graphRuntime ? await graphValidationArchiveForTask(request.taskId) : null;
  const extraReadOnlyPaths = Array.from(new Set([
    ...resourceAccess.read,
    ...(resourceAccess.protectedPaths || []),
    ...(graphRuntime && !('workflowPermissionSnapshot' in permissionConfig) ? [] : resolveLocalRuntimeReadOnlyPaths(request.workingDirectory || process.cwd(), permissionConfig)),
    ...(request.extraReadOnlyPaths || []),
    ...(output?.readOnlyPaths || []),
    ...(inputs?.paths || []),
    ...(validationArchive ? [validationArchive] : []),
    ...(graphRuntime?.readonly || []), ...graphGit,
    ...(graphRuntime ? await graphMaterialPathsForTask(request.taskId, true) : []),
    ...(graphRuntime ? graphDependencyPaths(workspaceRoot) : []),
    ...(graphGit.length && workspaceRoot ? [path.join(workspaceRoot, ".git")] : []),
    ...(permissionConfig.sandboxMode === 'read-only'
      ? [workspaceRoot, ...(request.extraReadOnlyPaths || [])].flatMap(linkedWorktreeGitDirectories)
      : []),
  ]));
  const declaredRuntime = output && runtimeWorkspace ? await prepareTaskDeclaredRuntime({ conversationAssociation: !request.graphExecution && !request.graphReview ? request.graphAssociation : undefined, taskId: request.taskId, taskRunId, permissionConfig, workspace: runtimeWorkspace, approvedReadOnlyRoots: [...extraReadOnlyPaths, ...extraWritableRoots], outputDirectory: output.directory, priorArtifacts: output.priorArtifacts, writerNonce: (await graphWriterEnvironment(taskRunId)).AP_GRAPH_WRITER_NONCE }) : null;
  if (declaredRuntime) { task.description += declaredRuntime.instructions; extraReadOnlyPaths.push(...declaredRuntime.readOnlyPaths); }
  if (graphRuntime) extraWritableRoots.push(...graphRuntime.writable);
  const explicitWrites = permissionConfig.sandboxMode === 'read-only' ? [] : [...permissionConfig.writableRoots, ...(agentGit?.writable || []), ...resourceAccess.write, ...(inputs?.writablePaths || [])].filter((root): root is string => !!root);
  const protectedReads = new Set([...resourceAccess.read, ...(resourceAccess.protectedPaths || []), ...(inputs?.paths || []), ...(output?.readOnlyPaths || []), ...graphGit, ...(graphRuntime?.readonly || [])]);
  for (let i = extraReadOnlyPaths.length - 1; i >= 0; i--) {
    const root = extraReadOnlyPaths[i];
    if (!protectedReads.has(root) && explicitWrites.some(write => root === write)) extraReadOnlyPaths.splice(i, 1);
  }
  const codexHome = graphRuntime && participant.harnessType === 'codex' ? graphRuntime.config : participant.harnessType === 'codex'
    ? resolvePlatformLocalCodexHome(workspaceRoot, participant.codexHome)
    : participant.codexHome;
  const protocol = new AgentProtocolOutput();
  const protocolCallbacks: HarnessStreamCallbacks = { ...callbacks, onStdoutChunk: (chunk, message) => {
    protocol.append(chunk, message);
    return callbacks.onStdoutChunk?.(chunk, message);
  } };
  const harnessCallbacks = participant.harnessType === 'codex'
    ? {
        ...protocolCallbacks,
        onCodexRateLimits: (event: Parameters<NonNullable<HarnessStreamCallbacks['onCodexRateLimits']>>[0]) => {
          updateCodexQuotaCache({ codexHome, ...event });
        },
      }
    : protocolCallbacks;
  if (workspaceRoot && !['codex', 'claude', 'claude-haha', 'kimi-code', 'antigravity', 'deepseek', 'pi-agent'].includes(participant.harnessType)) {
    throw new Error(`受限 Feishu 工作区暂不支持 harness: ${participant.harnessType}`);
  }
  let serviceSignal: AbortSignal | undefined;
  const registerSpawn = (child: ChildProcess) => {
    const abort = () => child.kill('SIGKILL');
    serviceSignal?.addEventListener('abort', abort, { once: true });
    child.once('exit', () => serviceSignal?.removeEventListener('abort', abort));
    if (serviceSignal?.aborted) abort();
    registerRunningProcess({
      taskRunId,
      participantId,
      child,
      executionBackend: participant.executionBackend,
      harnessType: participant.harnessType,
    });
    onSpawn?.(child);
  };

  const registerManagedSpawn = (control: ManagedProcessControl) => {
    const abort = () => { control.kill('SIGKILL'); };
    serviceSignal?.addEventListener('abort', abort, { once: true });
    control.onClosed(() => serviceSignal?.removeEventListener('abort', abort));
    registerRunningProcess({ taskRunId, participantId, child: control,
      executionBackend: participant.executionBackend, harnessType: participant.harnessType });
    if (serviceSignal?.aborted) abort();
    onSpawn?.({ pid: control.pid, sandboxIdentity: control.identity });
  };
  const sandbox: HarnessSandbox | undefined = (isGraph || resourceAccess.approvalIds.length > 0)
    && participant.executionBackend === 'platform_local' && participant.harnessType === 'codex' && workspaceRoot
    ? { run: async (input, use) => {
        let exitCode: number | null = null;
        try {
          return await withSandbox({ ...input, requiredWritableRoots: resourceAccess.write }, async managed => {
            managed.child.once('exit', code => { exitCode = code; });
            return use(managed);
          }, { onSpawn: registerManagedSpawn });
        } catch (error) {
          if (exitCode === 73 && resourceAccess.write.length) throw new ResourceApplicationError(
            `补充目录实际写入检查失败：${error instanceof Error ? error.message : String(error)}`, resourceAccess.write);
          throw error;
        }
      } }
    : undefined;

  return withTaskProjectCapabilities({ taskId: request.taskId, taskRunId, workspace: workspaceRoot || request.workingDirectory || process.cwd(), ...('workflowPermissionSnapshot' in permissionConfig ? { allowedReadOnlyRoots: extraReadOnlyPaths } : {}) }, async capabilities => {
  extraReadOnlyPaths.push(...capabilities.readOnlyPaths);
  task.description += capabilities.instructions;
  if (resourceAccess.approvalIds.length) await recordResourceMountPlan(taskRunId, participantId, resourceAccess.write, extraReadOnlyPaths, [workspaceRoot, ...extraWritableRoots].filter((root): root is string => !!root));
  return withGraphTaskServices(graphRuntime ? request.taskId : undefined, taskRunId, async services => {
  serviceSignal = services.signal;
  if (services.receipts.length) task.description += `\n平台已核验的临时服务：${services.env.TASK_GRAPH_SERVICES_JSON}。仅在本阶段使用，数据隔离，阶段结束回收；不得连接未声明的宿主服务。`;
  const taskEnvironment = { ...(resourceAccess.approvalIds.length ? { AP_RESOURCE_SCOPE: '1' } : {}), ...capabilities.env, ...inputs?.env, ...services.env, ...output?.env, ...declaredRuntime?.env, ...await graphWriterEnvironment(taskRunId) };
  const runtimeExecution = await beginHarnessRuntimeExecution(participantId);
  let metadataWrites = Promise.resolve();
  let boundSessionId: string | undefined;
  const onSessionStarted = (session: import('@/lib/harness/types').HarnessSessionStarted) => {
    metadataWrites = metadataWrites.then(async () => {
      try {
        const expectedNative = participant.resumeSessionId || participant.resumeThreadId;
        if (resourceAccess.approvalIds.length && expectedNative && expectedNative !== (session.threadId || session.sessionId)) throw new Error('资源接续返回不同的原生 Session');
        await assertResourceUseActive(taskRunId, resourceAccess.approvalIds);
        await markResourceRunEffective(request, taskRunId, session.threadId || session.sessionId);
        if (resourceAccess.approvalIds.length) await recordResourceSession(taskRunId, participantId, session.threadId || session.sessionId);
        await persistPlatformLocalSessionMetadata(
          taskRunId, participantId, session.sessionKind, session.sessionId, session.threadId,
        );
        boundSessionId = session.threadId || session.sessionId;
      } catch (error) {
        boundSessionId = undefined;
        if (request.resourceContinuation || resourceAccess.approvalIds.length) throw error;
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
  const context: HarnessExecutionContext = {
    sandbox,
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
    runtimeHome: graphRuntime?.home,
    taskEnvironment,
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
    onSessionSize: async sample => {
      await metadataWrites;
      if (sample.sessionId === boundSessionId && await persistSessionSize(runtimeExecution, sample)) {
        await callbacks.onSessionSize?.(sample);
      }
    },
    onSessionStarted,
  };
  const stageRequest = stageAuthority ? StageExecutionRequest.create({
    authority: stageAuthority, runtime: stageRuntimeContract(context), prompt: task.description,
  }) : null;
  const authority = await captureStageAuthority(request, taskRunId);
  const result = await withResourceProcessGuard(taskRunId, participantId, resourceAccess.approvalIds, () =>
    executePreparedStageHarness({ adapter, request, participant, task, context, stageRequest, authority,
      continuationContext: { capabilityInstructions: capabilities.instructions, longFileContext } }));

  await metadataWrites;
  if (result.runtimeState && result.sessionId && result.sessionKind) {
    await onSessionStarted({ sessionId: result.sessionId, sessionKind: result.sessionKind, threadId: result.threadId });
  }
  if (result.contextUsage) await onContextUsage(result.contextUsage);
  if (request.resourceContinuation && result.success && (!boundSessionId || (result.threadId || result.sessionId) !== boundSessionId)) {
    throw new Error('接续未确认原生 Session 身份，保留现场');
  }
  if (!result.success) {
    throw new Error(result.error || `${adapter.displayName} execution failed`);
  }

  if (result.runtimeState && result.runtimeState.sessionId === boundSessionId) {
    await persistHarnessRuntimeState(runtimeExecution, result.runtimeState);
  } else if (result.runtimeState) {
    console.warn('Runtime telemetry: missing current execution session binding', participantId);
  }

  return {
    output: await submitRunnerResourceRequest({ request, taskRunId, participantId, participant,
      output: result.output || `${adapter.displayName} completed`, protocolOutput: protocol.finalOutput(result.output || '') }),
    filesModified: result.filesModified ?? [],
    executionTime: result.executionTime,
    liveStreaming: result.liveStreaming ?? false,
    sessionId: result.sessionId,
    sessionKind: result.sessionKind,
    threadId: result.threadId,
  };
  }, declaredRuntime);
  });
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
    const runtime = await beginHarnessRuntimeExecution(participantId);
    return executeRemoteRunnerTask({
      onSessionSize: async (sessionId, size) => {
        const sample = normalizeSessionSize({ ...(size && typeof size === 'object' ? size : {}), executionId: runtime.id, sessionId, observedAt: Date.now() });
        if (!sample) return;
        if (await persistSessionSize(runtime, sample, { sessionKind: 'pi_session_dir' })) await callbacks.onSessionSize?.(sample);
      },
      nodeName,
      taskId: request.taskId,
      cwd: remoteWorkspace,
      prompt: harnessContinuationInput(request, participant, buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning)),
      sessionDir: participant.resumeSessionId || participant.resumeThreadId,
      continuation: Boolean(participant.resumeSessionId || participant.resumeThreadId),
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

  const runtime = participant.harnessType === 'pi-agent' ? await beginHarnessRuntimeExecution(participantId) : null;
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
      onSessionSize: runtime ? async (sessionId, size) => {
        const sample = normalizeSessionSize({ ...size, executionId: runtime.id, sessionId, observedAt: Date.now() });
        if (sample && await persistSessionSize(runtime, sample, { sessionKind: 'pi_session_dir' })) await callbacks.onSessionSize?.(sample);
      } : undefined,
      resumeSessionId: participant.resumeSessionId || participant.resumeThreadId,
      continuationMessage: participant.resumeSessionId
        ? harnessContinuationInput(request, participant, buildHarnessPrompt(request, participant, previousSummaries, taskRoomContext, contextWarning)) : undefined,
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
