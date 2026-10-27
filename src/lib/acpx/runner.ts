import { lockWriterAdmission, assertWorkspaceWriterAvailable, WorkspaceWriterBusy } from '../task-graph/writer-admission';
import { graphAssociationForTask, associationReviewCandidates, assertRoomRunTarget } from '../task-graph/graph-association';
import { assertGraphResetComplete } from '../task-graph/conversation-reset';
import { attachScheduledResourceContinuation, reserveResourceContinuation, resourceContinuationExit } from '../task-resources/runtime';
import type { Prisma } from '@prisma/client';
import { createGraphWriter, releaseTaskRunWriter } from '../task-graph/writer-ownership';
import { bindGraphReviewTaskRun } from '../task-graph/review-ownership';
import { bindExecutionTaskRun } from '../task-graph/execution-progress';
import { bindConversationInputs, completeConversationTurn, registerConversationSteering } from '../task-graph/conversation-inbox';
import { prisma } from '@/lib/prisma';
import { wakeWorkflowWatcherForTaskRun } from '@/lib/scheduled-jobs/runner';
import { getHarnessCapabilities } from './capabilities';
import { publishTaskRunEvent } from './event-bus';
import { getLongFileRuntimeContext } from './long-file-runtime-context';
import { DEFAULT_ACPX_PERMISSION_CONFIG, getLocalHarnessPermissionSupport } from './permissions';
import { executeParticipant } from './runner-participant';
import { stringifyJson } from './runner-metadata';
import { getParticipantContinuationKey } from './session-tracking';
import { ensureTaskSession, setTaskSessionActiveRun } from './session';
import type { AcpxRunRequest, TaskRunStatus } from './types';

export class AcpxRunStartupError extends Error {
  constructor(readonly taskRunId: string, message: string, readonly cause?: unknown) { super(message); Object.setPrototypeOf(this, new.target.prototype); }
}

export const executeAcpxTaskRun = async (request: AcpxRunRequest) => {
  request = await attachScheduledResourceContinuation(request);
  if (request.graphConversation) throw new Error('Legacy graph conversation startup has been retired');
  if (request.graphExecution && request.graphReview) throw new Error('TaskRun has multiple graph authorities');
  const association = await graphAssociationForTask(request.taskId, request.participants[0]?.role || '');
  if (request.graphAssociation && (!association || association.nodeId !== request.graphAssociation.nodeId ||
      association.runId !== request.graphAssociation.runId || JSON.stringify(association.executionIds) !== JSON.stringify(request.graphAssociation.executionIds) ||
      request.participants.some(participant => participant.role !== request.graphAssociation!.role))) throw new Error('Graph association does not match registered task identity');
  request = { ...request, graphAssociation: association ? { ...association, ...(request.graphAssociation?.roomMessageId ? { roomMessageId: request.graphAssociation.roomMessageId } : {}), ...(request.graphAssociation?.sourceTaskRunId ? { sourceTaskRunId: request.graphAssociation.sourceTaskRunId } : {}) } : undefined };
  const reviewCandidates = await associationReviewCandidates(request.taskId, request.graphAssociation);
  const taskSession =
    request.taskSessionId
      ? await prisma.taskSession.findUnique({ where: { id: request.taskSessionId } })
      : await ensureTaskSession(request.taskId, {
          taskName: request.taskName,
          metadata: {
            executionMode: 'acpx',
          },
        });

  if (!taskSession || taskSession.taskId !== request.taskId) {
    throw new Error(`Task session not found for task "${request.taskId}"`);
  }

  const supportedWriter = request.participants.length > 0 && request.participants.every(participant => participant.executionBackend === 'platform_local' && ['codex', 'kimi-code'].includes(participant.harnessType));
  const graphWriter = supportedWriter ? await createGraphWriter() : undefined;
  if (request.graphExecution && request.graphReview) throw new Error('A TaskRun cannot bind implementation and review simultaneously');
  const createRun = (tx: Pick<Prisma.TransactionClient, 'taskRun'>) => tx.taskRun.create({
    data: {
      taskId: request.taskId,
      taskSessionId: taskSession.id,
      mode: 'acpx',
      orchestrationMode: request.orchestrationMode,
      status: 'running',
      activityState: 'quiet',
      watchdogConfig: stringifyJson(request.watchdogConfig ?? null),
      controlMetadata: stringifyJson({
        ...(graphWriter ? { graphWriter } : {}),
        ...(reviewCandidates ? { reviewCandidates } : {}),
        workingDirectory: request.workingDirectory || process.cwd(),
        ...(request.graphReview ? { graphReview: request.graphReview } : {}),
        ...(request.graphAssociation ? { graphAssociation: request.graphAssociation } : {}),
        ...(request.graphConversation ? { graphConversation: request.graphConversation } : {}),
        permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
        permissionSupport: request.participants.map((participant) => ({
          participantKey: `${participant.executionBackend}:${participant.harnessType}:${participant.role}`,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
          role: participant.role,
          support: getLocalHarnessPermissionSupport(
            participant.harnessType,
            participant.executionBackend
          ),
        })),
      }),
      lastActivityAt: new Date(),
      startedAt: new Date(),
      participants: {
        create: request.participants.map((participant) => {
          const capabilities = getHarnessCapabilities(
            participant.harnessType,
            participant.executionBackend
          );

          return {
            gatewayId: participant.gatewayId,
            gatewayNameSnapshot: participant.gatewayName || participant.gatewayId,
            executionBackend: participant.executionBackend,
            harnessType: participant.harnessType,
            harnessNameSnapshot: participant.harnessLabel || participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
            agentNameSnapshot: participant.agentName || null,
            runner: participant.harnessType,
            status: 'pending',
            activityState: 'quiet',
            interruptSupported: capabilities.supportsImmediateInterrupt,
            resumeSupported: capabilities.supportsResumeAfterInterrupt,
            sessionControlSupported: capabilities.supportsLiveSessionControl,
            softStopSupported: capabilities.supportsSoftStop,
            controlMetadata: stringifyJson({
              ...capabilities,
              continuationKey: getParticipantContinuationKey(participant),
              resumeSessionId: participant.resumeSessionId || participant.resumeThreadId,
              permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
              permissionSupport: getLocalHarnessPermissionSupport(
                participant.harnessType,
                participant.executionBackend
              ),
            }),
          };
        }),
      },
    },
    include: {
      participants: true,
    },
  });

  request = { ...request, taskSessionId: taskSession.id };
  const graphExecution = request.graphExecution;
  const conversationExecutions = graphExecution ? [graphExecution.executionId] : request.graphConversation ? [request.graphConversation.executionId]
    : request.graphReview ? (await prisma.taskGraphExecution.findMany({ where: { nodeId: request.graphReview.nodeId }, select: { id: true } })).map(job => job.id) : request.graphAssociation?.executionIds || [];
  const resourceExit = await resourceContinuationExit(request);
  const startRun = () => prisma.$transaction(async tx => {
    await lockWriterAdmission(tx);
    if (supportedWriter && request.workingDirectory || request.graphAssociation || request.graphExecution || request.graphReview) await assertWorkspaceWriterAvailable(tx, {
      taskId: request.taskId, nodeId: request.graphAssociation?.nodeId || request.graphReview?.nodeId, directory: request.workingDirectory,
      executionClaim: request.graphExecution, reviewClaim: request.graphReview,
    });
    const resetTasks = conversationExecutions.length ? await tx.taskGraphExecution.findMany({ where: { id: { in: conversationExecutions } }, select: { childTaskId: true } }) : [];
    for (const id of Array.from(new Set(resetTasks.map(job => job.childTaskId).filter((id): id is string => !!id))).sort()) {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${request.taskId} FOR UPDATE`;
    if (request.resourceContinuation && (await tx.task.findUniqueOrThrow({ where: { id: request.taskId } })).currentTaskSessionId !== taskSession.id) throw new Error('原任务 Session 已改变');
    await tx.$queryRaw`SELECT id FROM "TaskSession" WHERE id = ${taskSession.id} FOR UPDATE`;
    if (!graphExecution && !request.graphReview && !request.graphConversation && await tx.taskRun.count({
      where: { taskSessionId: taskSession.id, status: { in: ['pending', 'running', 'waiting_for_input'] } },
    })) throw new Error('Session already has an active run');
    await assertGraphResetComplete(tx, conversationExecutions, request.participants);
    const created = await createRun(tx);
    if (graphExecution) {
      await bindExecutionTaskRun(tx, graphExecution, created.id);
      await bindConversationInputs(tx, graphExecution.executionId, graphExecution.inputIds || [], created.id);
    }
    if (request.graphAssociation?.roomMessageId) await assertRoomRunTarget(tx, request.graphAssociation, created.id);
    if (request.graphReview) await bindGraphReviewTaskRun(tx, request.graphReview, created.id);
    await reserveResourceContinuation(tx, request, created.id, resourceExit);
    return created;
  });

  const waitForWriter = async () => {
    for (;;) {
      try { return await startRun(); } catch (error) {
        if (!(error instanceof WorkspaceWriterBusy) || error.observation !== 'alive' || request.graphExecution || request.graphReview) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };
  const taskRun = await waitForWriter();

  if (conversationExecutions.length) {
    const external = request.streamCallbacks?.onSteeringReady;
    request = { ...request, streamCallbacks: { ...request.streamCallbacks, onSteeringReady: steer => {
      const unregister = conversationExecutions.map(id => registerConversationSteering(id, taskRun.id, steer));
      const detach = external?.(steer);
      return () => { unregister.forEach(detach => detach()); detach?.(); };
    } } };
  }

  const participantResults: Array<Awaited<ReturnType<typeof executeParticipant>>> = [];
  try {
    await request.streamCallbacks?.onRunStarted?.(taskRun.id);
    await setTaskSessionActiveRun(taskSession.id, taskRun.id);

    await publishTaskRunEvent({
      taskId: request.taskId,
      taskRunId: taskRun.id,
      eventType: 'runner_started',
      content: `ACPX 运行开始，共 ${request.participants.length} 个参与方`,
        metadata: {
          mode: 'acpx',
          taskSessionId: taskSession.id,
          orchestrationMode: request.orchestrationMode,
          workingDirectory: request.workingDirectory ?? null,
          extraReadOnlyPaths: request.extraReadOnlyPaths || [],
          permissionConfig: request.permissionConfig ?? DEFAULT_ACPX_PERMISSION_CONFIG,
          permissionSupport: request.participants.map((participant) => ({
            executionBackend: participant.executionBackend,
            harnessType: participant.harnessType,
            role: participant.role,
            support: getLocalHarnessPermissionSupport(
              participant.harnessType,
              participant.executionBackend
            ),
          })),
          watchdogConfig: request.watchdogConfig ?? null,
          participants: request.participants,
        },
    });

    const previousSummaries: string[] = [];
    const longFileContext = request.participants.some((participant) => participant.executionBackend === 'platform_local') ? await getLongFileRuntimeContext({ executionBackend: 'platform_local', workingDirectory: request.workingDirectory }) : null;

    for (let index = 0; index < taskRun.participants.length; index += 1) {
      const participantRecord = taskRun.participants[index];
      const requestParticipant = request.participants[index];
      const result = await executeParticipant(
        request,
        taskRun.id,
        participantRecord.id,
        requestParticipant,
        previousSummaries, longFileContext,
      );
      participantResults.push(result);
      if (result.summary) {
        previousSummaries.push(
          `${requestParticipant.role} @ ${requestParticipant.gatewayName || requestParticipant.gatewayId} / ${requestParticipant.harnessType}: ${result.summary}`
        );
      }

      if (result.status === 'interrupted' || result.status === 'stopped') {
        break;
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.$transaction(async tx => {
      await tx.taskRunParticipant.updateMany({ where: { taskRunId: taskRun.id, status: { in: ['pending', 'running', 'waiting_for_input'] } },
        data: { status: 'failed', activityState: 'stalled', completedAt: new Date(), error: detail } });
      await tx.taskRun.update({ where: { id: taskRun.id }, data: { status: 'failed', activityState: 'stalled', completedAt: new Date(), error: detail, summary: detail } });
      await tx.taskSession.updateMany({ where: { id: taskSession.id, activeRunId: taskRun.id },
        data: { activeRunId: null, status: 'failed', attentionState: 'error', summary: detail } });
    });
    throw new AcpxRunStartupError(taskRun.id, detail, error);
  } finally {
    // executeParticipant settles its metadata writes and service cleanup before this boundary.
    if (graphWriter) await releaseTaskRunWriter(taskRun.id, graphWriter.nonce);
  }

  const failedParticipants = participantResults.filter((result) => result.status === 'failed');
  const completedParticipants = participantResults.filter((result) => result.status === 'completed');
  const interruptedParticipant = participantResults.find((result) => result.status === 'interrupted');
  const stoppedParticipant = participantResults.find((result) => result.status === 'stopped');
  const runStatus: TaskRunStatus = stoppedParticipant
    ? 'stopped'
    : interruptedParticipant
    ? 'interrupted'
    : failedParticipants.length > 0
    ? 'failed'
    : 'completed';
  const summaryLines = participantResults.map((result) =>
    `${result.role} @ ${result.gatewayName} / ${result.harnessType}: ${
      result.status === 'completed' ? result.summary || '完成' : result.error || '失败'
    }`
  );

  await prisma.taskRun.update({
    where: { id: taskRun.id },
    data: {
      status: runStatus,
      activityState: runStatus === 'completed' ? 'quiet' : 'stalled',
      completedAt: new Date(),
      summary: summaryLines.join('\n'),
      error:
        runStatus === 'failed'
          ? `${failedParticipants.length} participant(s) failed`
          : runStatus === 'interrupted'
          ? 'Run interrupted by user'
          : runStatus === 'stopped'
          ? 'Run stopped by user'
          : null,
    },
  });

  await prisma.taskSession.update({
    where: { id: taskSession.id },
    data: {
      status: runStatus === 'completed' ? 'active' : 'failed',
      attentionState:
        runStatus === 'completed'
          ? 'normal'
          : runStatus === 'interrupted' || runStatus === 'stopped'
          ? 'needs_review'
          : 'error',
      summary: summaryLines.join('\n'),
      activeRunId: null,
    },
  });

  await publishTaskRunEvent({
    taskId: request.taskId,
    taskRunId: taskRun.id,
    eventType:
      runStatus === 'completed'
        ? 'run_completed'
        : runStatus === 'interrupted'
        ? 'run_interrupted'
        : runStatus === 'stopped'
        ? 'run_stopped'
        : 'run_failed',
    content:
      runStatus === 'completed'
        ? `ACPX 运行完成，成功 ${completedParticipants.length} 个参与方`
        : runStatus === 'interrupted'
        ? 'ACPX 运行已被用户立即介入中断'
        : runStatus === 'stopped'
        ? 'ACPX 运行已被用户停止'
        : `ACPX 运行失败，失败 ${failedParticipants.length} 个参与方`,
    metadata: {
      summaries: participantResults,
    },
  });

  if (runStatus === 'completed' && !request.graphExecution && !request.graphReview && !request.graphConversation && !request.graphAssociation
    && request.participants.some(participant => participant.executionBackend === 'platform_local')) {
    void wakeWorkflowWatcherForTaskRun(prisma, request.taskId, taskRun.id)
      .catch(error => console.error('[ACPX] workflow watcher wakeup failed:', error));
  }

  const conversationExecution = graphExecution || request.graphConversation;
  if (conversationExecution) await completeConversationTurn(conversationExecution.executionId, taskRun.id);
  return {
    taskRunId: taskRun.id,
    status: runStatus,
    summary: summaryLines.join('\n'),
    participants: participantResults,
  };
};
