import { SandboxScopeError, type SandboxIdentity } from '../sandbox-manager';
import { RuntimePreparationError } from '../task-graph/runtime-preflight';
import { redactSensitiveText } from '../redact-sensitive';
import { prisma } from '@/lib/prisma';
import { buildTaskRoomPromptContext } from '@/lib/task-room';
import { prepareFeishuBroadcastPrompt, ackFeishuBroadcastPrompt } from '@/lib/feishu-task-broadcast';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from './permissions';
import { publishTaskRunEvent } from './event-bus';
import { clearRunningProcess, consumeRunControlRequest } from './process-registry';
import { finishPendingTaskRunInteractionRequests } from './interactions';
import { createStreamWriteBuffer } from './stream-write-buffer';
import { getWorkflowCompletionBaseline, shouldCheckWorkflowCompletion } from './workflow-completion-gate';
import { completeWorkflowInOriginalSession } from './workflow-completion-session';
import { assertLongFileRuntimeContext, type LongFileRuntimeContext } from './long-file-runtime-context';
import { checkContextWatermark } from './prompt';
import {
  parseModifiedFiles,
  persistPlatformLocalSessionMetadata,
  persistSpawnedHarnessMetadata,
} from './runner-metadata';
import {
  clearWaitingForInputIfNeeded,
  detectHarnessInteractionRequest,
  handleHarnessInteractionRequest,
  toParticipantPayload,
} from './runner-interactions';
import {
  executeViaGateway,
  executeViaLocalHarness,
  executeViaRemoteSshHarness,
} from './runner-harness';
import type {
  AcpxParticipantRequest,
  AcpxRunRequest,
  HarnessStreamCallbacks,
  RunControlAction,
  TaskRunStatus,
} from './types';

const mapControlActionToRunStatus = (action: RunControlAction): TaskRunStatus =>
  action === 'stop_run' ? 'stopped' : 'interrupted';


export const executeParticipant = async (
  request: AcpxRunRequest,
  taskRunId: string,
  participantId: string,
  participant: AcpxParticipantRequest,
  previousSummaries: string[], runLongFileContext: LongFileRuntimeContext | null,
) => {
  const registryParticipantId = participantId;

  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      status: 'running',
      activityState: 'quiet',
      lastActivityAt: new Date(),
      startedAt: new Date(),
    },
  });

  const participantPayload = toParticipantPayload({
    gatewayId: participant.gatewayId,
    gatewayNameSnapshot: participant.gatewayName || participant.gatewayId,
    executionBackend: participant.executionBackend,
    harnessType: participant.harnessType,
    harnessNameSnapshot: participant.harnessLabel || participant.harnessType,
    role: participant.role,
    agentId: participant.agentId,
    agentNameSnapshot: participant.agentName || null,
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId,
    participantId,
    participant: participantPayload,
    eventType: 'participant_started',
    content: `${participant.role} 开始执行 (${participantPayload.gatewayName} / ${participant.harnessType})`,
  });

  const streamWrites = createStreamWriteBuffer(async (writes) => {
    const now = new Date();
    const hasStdout = writes.some(({ stream }) => stream === 'stdout');
    const hasStderr = writes.some(({ stream }) => stream === 'stderr');
    await prisma.$transaction([
      prisma.taskRun.update({
        where: { id: taskRunId },
        data: {
          activityState: 'streaming',
          lastActivityAt: now,
          lastStdoutAt: hasStdout ? now : undefined,
          lastStderrAt: hasStderr ? now : undefined,
        },
      }),
      prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: { activityState: 'streaming', lastActivityAt: now },
      }),
    ]);
    for (const write of writes) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: `${write.stream}_chunk`,
        stream: write.stream,
        content: write.content,
        ...(write.agentMessage ? { metadata: { agentMessage: write.agentMessage } } : {}),
      });
    }
    if (writes.some(({ interactionDetected }) => !interactionDetected)) {
      await clearWaitingForInputIfNeeded(taskRunId, participantId);
    }
  });
  let subagentEventWrites = Promise.resolve();
  let spawnedMetadataWrites = Promise.resolve();

  const callbacks: HarnessStreamCallbacks = {
    onSessionSize: sample => request.streamCallbacks?.onSessionSize?.(sample),
    onSteeringReady: participant.executionBackend === 'platform_local' && (participant.harnessType === 'pi-agent' || participant.harnessType === 'codex')
      && !request.workflowCompletionGate
      ? request.streamCallbacks?.onSteeringReady : undefined,
    onStdoutChunk: async (chunk, agentMessage) => {
      // Only legacy terminal output may carry implicit interaction prompts.
      const interactionRequest = agentMessage ? null : detectHarnessInteractionRequest(chunk, participant.harnessType);
      streamWrites.push({ stream: 'stdout', content: chunk, interactionDetected: Boolean(interactionRequest), ...(agentMessage ? { agentMessage } : {}) });
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          runRequest: request,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
          workingDirectory: request.workingDirectory || process.cwd(),
          permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
        });
      }

      if (request.streamCallbacks?.onStdoutChunk) {
        try {
          await request.streamCallbacks.onStdoutChunk(chunk, agentMessage);
        } catch (error) {
          console.error('[ACPX] request stdout stream callback failed:', error);
        }
      }
    },
    onStderrChunk: async (chunk) => {
      const interactionRequest = detectHarnessInteractionRequest(chunk, participant.harnessType);
      streamWrites.push({ stream: 'stderr', content: chunk, interactionDetected: Boolean(interactionRequest) });
      if (interactionRequest) {
        await handleHarnessInteractionRequest({
          request: interactionRequest,
          runRequest: request,
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
          workingDirectory: request.workingDirectory || process.cwd(),
          permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
        });
      }

      if (request.streamCallbacks?.onStderrChunk) {
        try {
          await request.streamCallbacks.onStderrChunk(chunk);
        } catch (error) {
          console.error('[ACPX] request stderr stream callback failed:', error);
        }
      }
    },
    onToolEvent: (event) => {
      subagentEventWrites = subagentEventWrites.then(async () => {
        await publishTaskRunEvent({ taskId: request.taskId, taskRunId, participantId,
          participant: participantPayload, eventType: 'control_message',
          content: redactSensitiveText(`工具：${event.toolName} · ${event.preview}`),
          metadata: { kind: 'tool', toolName: event.toolName, ...(event.status ? { status: event.status } : {}),
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}) } });
        await request.streamCallbacks?.onToolEvent?.(event);
      }).catch((error) => console.error('[ACPX] tool event persistence failed:', error));
      return subagentEventWrites;
    },
    onSubagentEvent: (event) => {
      subagentEventWrites = subagentEventWrites.then(async () => {
        const completed = event.status === 'completed';
        const started = event.status === 'running';
        const { output, ...metadata } = event;
        await publishTaskRunEvent({
          taskId: request.taskId,
          taskRunId,
          participantId,
          participant: participantPayload,
          eventType: started ? 'subagent_started' : completed ? 'subagent_completed' : 'subagent_failed',
          stream: 'system',
          content: [
            `SubAgent ${event.ordinal && event.limit ? `${event.ordinal}/${event.limit} ` : ''}${event.agentId || event.taskId}: ${event.description} [${event.status}]`,
            output,
          ].filter(Boolean).join('\n\n'),
          metadata,
        });
        await request.streamCallbacks?.onSubagentEvent?.(event);
      }).catch((error) => {
        console.error('[ACPX] subagent event callback failed:', error);
      });
      return subagentEventWrites;
    },
    onInteractionRequest: participant.executionBackend === 'platform_local'
      && participant.harnessType === 'codex'
      ? async (interactionRequest) => {
          const decision = await handleHarnessInteractionRequest({
            request: interactionRequest,
            runRequest: request,
            taskId: request.taskId,
            taskRunId,
            participantId,
            participant: participantPayload,
            workingDirectory: request.workingDirectory || process.cwd(),
            permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
          });
          return decision || 'deny';
        }
      : undefined,
  };

  const longFileContext = participant.executionBackend === 'platform_local' ? runLongFileContext : null;
  try {
    const workflowBaseline = shouldCheckWorkflowCompletion(request.workflowCompletionGate, participant.executionBackend)
      ? await getWorkflowCompletionBaseline(request.workingDirectory || process.cwd())
      : null;
    const taskRoomContext = await buildTaskRoomPromptContext(request.taskId, request.taskName, 30);
    const broadcasts = await prepareFeishuBroadcastPrompt(request, participant);
    if (broadcasts?.text) {
      taskRoomContext.transcript += broadcasts.text;
      if (participant.continuationMessage) {
        participant = { ...participant, continuationMessage: participant.continuationMessage + broadcasts.text };
      }
    }
    const contextWarning = await checkContextWatermark(
      request.taskId,
      request.taskName,
      request.taskSessionId,
      participant,
      participantId,
    );
    const localSpawnHandler = (child: { pid?: number; sandboxIdentity?: SandboxIdentity | null }) => {
      if (participant.executionBackend === 'platform_local') {
        spawnedMetadataWrites = spawnedMetadataWrites.then(async () => {
          await persistSpawnedHarnessMetadata(taskRunId, participantId, child.pid);
          if (child.sandboxIdentity) await publishTaskRunEvent({ taskId: request.taskId, taskRunId,
            participantId, eventType: 'runner_started', content: '执行环境已准备',
            metadata: { sandboxIdentity: child.sandboxIdentity } });
        })
          .catch(error => { console.error('[ACPX] Failed to persist spawned harness metadata:', error); });
      }
    };

    let result =
      participant.executionBackend === 'platform_local'
        ? await executeViaLocalHarness(
            request,
            taskRunId,
            participantId,
            participant,
            callbacks,
            previousSummaries,
            taskRoomContext,
            localSpawnHandler,
            contextWarning, longFileContext,
          )
        : participant.executionBackend === 'remote_ssh'
        ? await executeViaRemoteSshHarness(
            request,
            taskRunId,
            participantId,
            participant,
            callbacks,
            previousSummaries,
            taskRoomContext,
            localSpawnHandler,
            contextWarning
          )
        : await executeViaGateway(request, participant, previousSummaries, taskRoomContext, contextWarning);

    await spawnedMetadataWrites;
    await streamWrites.drain();
    await subagentEventWrites;

    clearRunningProcess(registryParticipantId, taskRunId);

    if (!result.liveStreaming) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'stdout_chunk',
        stream: 'stdout',
        content: result.output,
        metadata: {
          note: 'Gateway OpenClaw execution currently returns final output after completion.',
        },
      });
    }

    if (workflowBaseline) {
      await completeWorkflowInOriginalSession({
        cwd: request.workingDirectory || process.cwd(),
        baseline: workflowBaseline,
        taskId: request.taskId,
        taskName: request.taskName,
        sessionId: result.sessionId || result.threadId,
        sessionKind: result.sessionKind,
        correct: async (continuation) => {
          result = await executeViaLocalHarness(
            request, taskRunId, participantId,
            { ...participant, ...continuation },
            callbacks, previousSummaries, taskRoomContext,
            localSpawnHandler, contextWarning, longFileContext,
          );
        },
      });
    }

    if (longFileContext) await assertLongFileRuntimeContext(longFileContext);

    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'completed',
        activityState: 'quiet',
        completedAt: new Date(),
        summary: result.output,
        filesModified: parseModifiedFiles(result.filesModified),
      },
    });

    await persistPlatformLocalSessionMetadata(
      taskRunId,
      participantId,
      result.sessionKind,
      result.sessionId,
      result.threadId
    );

    if (result.filesModified?.length) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'file_modified',
        content: result.filesModified.join('\n'),
        metadata: {
          filesModified: result.filesModified,
        },
      });
    }

    if (!result.liveStreaming) {
      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: 'summary',
        content: result.output,
        metadata: {
          filesModified: result.filesModified ?? [],
          executionTime: result.executionTime,
          streamingMode: result.liveStreaming ? 'live' : 'final-only',
        },
      });
    }

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId,
      participantId,
      participant: participantPayload,
      eventType: 'participant_completed',
      content: `${participant.role} 执行完成`,
    });
    await finishPendingTaskRunInteractionRequests({ participantId, status: 'cancelled' });

    // Acknowledge only the frozen input of a successful attempt. An ack outage
    // leaves it pending for replay by stable ID; never fail a completed model run.
    try {
      await ackFeishuBroadcastPrompt(broadcasts, result.sessionId || result.threadId);
    } catch (error) {
      console.error('[ACPX] Feishu broadcast acknowledgement failed:', error);
    }

    return {
      participantId,
      gatewayId: participant.gatewayId,
      gatewayName: participantPayload.gatewayName,
      harnessType: participant.harnessType,
      role: participant.role,
      status: 'completed' as const,
      summary: result.output,
      filesModified: result.filesModified ?? [],
      executionTime: result.executionTime,
    };
  } catch (error) {
    try {
      await spawnedMetadataWrites;
      await streamWrites.drain();
      await subagentEventWrites;
    } catch (streamError) {
      console.error('[ACPX] Failed to persist buffered stream output:', streamError);
    }
    clearRunningProcess(registryParticipantId, taskRunId);
    if (error instanceof SandboxScopeError) {
      void error.cleanupCompletion.then(async outcome => {
        if (outcome.kind === 'failed') await publishTaskRunEvent({
          taskId: request.taskId, taskRunId, participantId, eventType: 'control_message',
          content: '执行环境清理失败，详细原因已记录。',
          metadata: { sandboxCleanup: { kind: outcome.kind, errors: outcome.errors.map(cause =>
            redactSensitiveText(cause instanceof Error ? cause.message : String(cause))) } },
        });
      }).catch(reportError => console.error('[ACPX] Sandbox cleanup receipt failed:', reportError));
    }
    if (error instanceof RuntimePreparationError) throw error;
    const longFileError = longFileContext && await assertLongFileRuntimeContext(longFileContext).catch((guardError) => guardError);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'; const message = longFileError instanceof Error && longFileError.message !== errorMessage ? `${errorMessage}\n\n${longFileError.message}` : errorMessage;
    await finishPendingTaskRunInteractionRequests({
      participantId,
      status: /timed out/i.test(message) ? 'expired' : 'cancelled',
    });
    const requestedControl = consumeRunControlRequest(registryParticipantId);

    if (requestedControl && !longFileError) {
      const controlledStatus = mapControlActionToRunStatus(requestedControl);

      await prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: {
          status: controlledStatus,
          activityState: 'terminating',
          completedAt: new Date(),
          error: requestedControl === 'stop_run' ? 'Stopped by user' : 'Interrupted by user',
        },
      });

      await publishTaskRunEvent({
        taskId: request.taskId,
        taskRunId,
        participantId,
        participant: participantPayload,
        eventType: requestedControl === 'stop_run' ? 'participant_stopped' : 'participant_interrupted',
        content: requestedControl === 'stop_run' ? `${participant.role} 已被用户停止` : `${participant.role} 已被用户中断`,
        metadata: {
          controlAction: requestedControl,
        },
      });

      return {
        participantId,
        gatewayId: participant.gatewayId,
        gatewayName: participantPayload.gatewayName,
        harnessType: participant.harnessType,
        role: participant.role,
        status: controlledStatus,
        error: requestedControl === 'stop_run' ? 'Stopped by user' : 'Interrupted by user',
        filesModified: [],
      };
    }

    await prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        status: 'failed',
        activityState: 'stalled',
        completedAt: new Date(),
        error: message,
      },
    });

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId,
      participantId,
      participant: participantPayload,
      eventType: 'participant_failed',
      content: `${participant.role} 执行失败: ${message}`,
      metadata: {
        error: message,
      },
    });

    return {
      participantId,
      gatewayId: participant.gatewayId,
      gatewayName: participantPayload.gatewayName,
      harnessType: participant.harnessType,
      role: participant.role,
      status: 'failed' as const,
      error: message,
      filesModified: [],
    };
  }
};
