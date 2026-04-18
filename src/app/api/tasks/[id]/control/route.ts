import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createTaskRunControlMessage } from '@/lib/acpx/control';
import { requestRunControl } from '@/lib/acpx/process-registry';
import { publishTaskRunEvent } from '@/lib/acpx/event-bus';
import { reconcileTaskRunLiveness } from '@/lib/acpx/liveness';
import { executeAcpxTaskRunWithContinuationFallback } from '@/lib/acpx/continuation-retry';
import { getContinuationSession } from '@/lib/acpx/session-tracking';
import {
  ensureTaskChatRoom,
  postTaskRoomMessage,
} from '@/lib/task-room';
import {
  getTaskRoomParticipantTargetKey,
  getTaskRoomParticipantTargetLabel,
} from '@/lib/task-room-targets';
import type {
  RunControlAction,
  RunControlDeliveryMode,
  AcpxParticipantRequest,
  AcpxPermissionConfig,
} from '@/lib/acpx/types';
import type { ChatMessageTargetType } from '@/lib/chat-types';
import { DEFAULT_ACPX_PERMISSION_CONFIG, normalizeAcpxPermissionConfig } from '@/lib/acpx/permissions';

export const dynamic = 'force-dynamic';

const USER_ID = 'task-room-user';
const USER_NAME = '用户';

const isControlAction = (value: unknown): value is RunControlAction =>
  value === 'queue_message' || value === 'interrupt_now' || value === 'stop_run' || value === 'continue_session';

const isDeliveryMode = (value: unknown): value is RunControlDeliveryMode =>
  value === 'queued' || value === 'immediate';

const isMessageTargetType = (value: unknown): value is ChatMessageTargetType =>
  value === 'task' || value === 'participant' || value === 'all';

const parseParticipants = (value: string | null | undefined): AcpxParticipantRequest[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as AcpxParticipantRequest[] : [];
  } catch {
    return [];
  }
};

const parseMetadata = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const stringifyMetadata = (value: Record<string, unknown>) => JSON.stringify(value);

const findActiveRunFromRuns = <TRun extends {
  status: string;
  createdAt: Date;
}>(runs: TRun[]) =>
  [...runs]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .find((run) => run.status === 'running' || run.status === 'waiting_for_input')
    ?? null;

const readTrackingObject = (metadata: Record<string, unknown>) =>
  metadata.sessionTracking && typeof metadata.sessionTracking === 'object'
    ? metadata.sessionTracking as Record<string, unknown>
    : {};

const readTrackingString = (tracking: Record<string, unknown>, key: string) =>
  typeof tracking[key] === 'string' && tracking[key]
    ? tracking[key] as string
    : null;

const toParticipantEventPayload = (participant: {
  id: string;
  gatewayId?: string | null;
  gatewayNameSnapshot: string;
  executionBackend: string;
  harnessType: string;
  harnessNameSnapshot?: string | null;
  role: string;
  agentId?: string | null;
  agentNameSnapshot?: string | null;
}) => ({
  gatewayId: participant.gatewayId,
  gatewayName: participant.gatewayNameSnapshot,
  executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
  harnessType: participant.harnessType,
  harnessLabel: participant.harnessNameSnapshot,
  role: participant.role,
  agentId: participant.agentId,
  agentName: participant.agentNameSnapshot,
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await reconcileTaskRunLiveness(params.id);

    const body = await request.json();
    const action = body.action;
    const deliveryMode = body.deliveryMode;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : null;
    const participantId =
      typeof body.participantId === 'string' && body.participantId.trim()
        ? body.participantId.trim()
        : null;
    const targetType = isMessageTargetType(body.targetType) ? body.targetType : 'task';
    const targetParticipantKey =
      typeof body.targetParticipantKey === 'string' && body.targetParticipantKey.trim()
        ? body.targetParticipantKey.trim()
        : null;

    if (!isControlAction(action) || !isDeliveryMode(deliveryMode)) {
      return NextResponse.json(
        { error: 'Invalid control action or delivery mode' },
        { status: 400 }
      );
    }

    if ((action === 'queue_message' || action === 'interrupt_now' || action === 'continue_session') && !content) {
      return NextResponse.json(
        { error: 'Message content is required for queue_message, interrupt_now, and continue_session' },
        { status: 400 }
      );
    }

    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: {
        currentTaskSession: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const permissionConfig = (() => {
      try {
        return normalizeAcpxPermissionConfig(
          JSON.parse(task.acpxPermissionConfig || 'null') as AcpxPermissionConfig | null
        );
      } catch {
        return DEFAULT_ACPX_PERMISSION_CONFIG;
      }
    })();

    const acpxParticipants = parseParticipants(task.acpxParticipants);
    const targetParticipantSpec = targetType === 'participant'
      ? acpxParticipants.find(
          (participant) => getTaskRoomParticipantTargetKey(participant) === targetParticipantKey
        ) ?? null
      : null;

    if (targetType === 'participant' && !targetParticipantSpec) {
      return NextResponse.json(
        { error: 'Invalid participant target' },
        { status: 400 }
      );
    }

    const room = await ensureTaskChatRoom(task.id, task.name);

    const fallbackActiveRun = !runId && !task.currentTaskSession?.activeRunId
      ? findActiveRunFromRuns(
          await prisma.taskRun.findMany({
            where: {
              taskId: task.id,
            },
            include: {
              participants: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
          })
        )
      : null;

    const targetRun = runId
      ? await prisma.taskRun.findFirst({
          where: {
            id: runId,
            taskId: task.id,
          },
          include: {
            participants: true,
          },
        })
      : task.currentTaskSession?.activeRunId
      ? await prisma.taskRun.findFirst({
          where: {
            id: task.currentTaskSession.activeRunId,
            taskId: task.id,
          },
          include: {
            participants: true,
          },
        })
      : fallbackActiveRun
      ? fallbackActiveRun
      : await prisma.taskRun.findFirst({
          where: {
            taskId: task.id,
          },
          include: {
            participants: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

    if ((action === 'interrupt_now' || action === 'stop_run' || action === 'continue_session') && !targetRun) {
      return NextResponse.json(
        { error: 'No task run available for this control action' },
        { status: 400 }
      );
    }

    const roomTargetParticipant = targetRun?.participants.find(
      (participant) =>
        targetType === 'participant'
        && getTaskRoomParticipantTargetKey({
          executionBackend: participant.executionBackend,
          gatewayId: participant.gatewayId,
          harnessType: participant.harnessType,
          role: participant.role,
          agentId: participant.agentId,
        }) === targetParticipantKey
    ) ?? null;

    const continuationParticipant = participantId
      ? targetRun?.participants.find((participant) => participant.id === participantId) ?? null
      : roomTargetParticipant
      ?? targetRun?.participants.find(
          (participant) => !!getContinuationSession(participant).sessionId
        )
      ?? null;

    const selectedParticipant = action === 'continue_session'
      ? continuationParticipant
      : participantId
      ? targetRun?.participants.find((participant) => participant.id === participantId) ?? null
      : targetRun?.participants.find(
          (participant) =>
            (participant.status === 'running' || participant.status === 'waiting_for_input')
            && participant.executionBackend === 'platform_local'
        )
        ?? targetRun?.participants.find(
          (participant) => participant.status === 'running' || participant.status === 'waiting_for_input'
        )
        ?? null;

    const userMessage = content
      ? await postTaskRoomMessage({
          roomId: room.id,
          content,
          userId: USER_ID,
          userName: USER_NAME,
          targetType,
          targetParticipantKey:
            targetType === 'participant' ? getTaskRoomParticipantTargetKey(targetParticipantSpec!) : null,
          targetParticipantLabel:
            targetType === 'participant' ? getTaskRoomParticipantTargetLabel(targetParticipantSpec!) : null,
        })
      : null;

    if (!targetRun) {
      await postTaskRoomMessage({
        roomId: room.id,
        content: '系统提示：当前没有活动 run，这条消息会保留在 task room 中供下一次运行读取。',
        userId: 'system',
        userName: '系统',
      });

      return NextResponse.json({
        ok: true,
        mode: 'room_only',
        roomMessageId: userMessage?.id ?? null,
      });
    }

    const continuationSession =
      action === 'continue_session' && selectedParticipant
        ? getContinuationSession(selectedParticipant)
        : { sessionId: null, sessionKind: null };
    const continuationSessionId = continuationSession.sessionId;
    const continuationSessionKind = continuationSession.sessionKind;

    const controlMessage = await createTaskRunControlMessage({
      taskId: task.id,
      taskSessionId: targetRun.taskSessionId,
      taskRunId: targetRun.id,
      roomMessageId: userMessage?.id ?? null,
      participantId: selectedParticipant?.id ?? null,
      senderUserId: USER_ID,
      senderName: USER_NAME,
      deliveryMode,
      controlAction: action,
      content: content || (action === 'stop_run' ? 'Stop requested by user' : 'Interrupt requested by user'),
      metadata: {
        executionMode: task.executionMode,
        roomTargetType: targetType,
        roomTargetParticipantKey:
          targetType === 'participant' ? getTaskRoomParticipantTargetKey(targetParticipantSpec!) : null,
        targetParticipantId: selectedParticipant?.id ?? null,
        targetParticipantRole: selectedParticipant?.role ?? null,
        targetParticipantBackend: selectedParticipant?.executionBackend ?? null,
        requestedDeliveryMode: deliveryMode,
        requestedAction: action,
        permissionConfig,
        continuationSessionId,
        continuationSessionKind,
        deliveryAttempted: action !== 'queue_message',
        deliveryResult: action === 'queue_message' ? 'queued' : 'pending_attempt',
        fallbackReason: null,
        fallbackAction: null,
      },
    });

    let applied = false;
    let systemMessage = '';
    let continuationRunId: string | null = null;
    let deliveryResult: 'queued' | 'delivered_to_active_thread' | 'delivered_control_signal' | 'rejected' | 'fallback_to_queue' = 'queued';
    let fallbackReason: string | null = null;
    let fallbackAction: 'queue_message' | null = null;
    let sessionTrackingResult: Record<string, unknown> | null = null;

    if (action === 'queue_message') {
      systemMessage = '系统提示：这条消息已作为排队指令记录；当前 run 不会被强制打断，后续 handoff 或下一轮运行才会读取它。';
      deliveryResult = 'queued';
    } else if (action === 'continue_session') {
      if (
        !selectedParticipant
        || !continuationSessionId
      ) {
        return NextResponse.json(
          { error: 'Selected participant does not support session continuation' },
          { status: 400 }
        );
      }

      await prisma.task.update({
        where: { id: task.id },
        data: {
          status: 'running',
          startedAt: task.startedAt || new Date(),
          completedAt: null,
          error: null,
        },
      });

      const continuationResult = await executeAcpxTaskRunWithContinuationFallback({
        staleParticipantId: selectedParticipant.id,
        request: {
          taskId: task.id,
          taskSessionId: targetRun.taskSessionId || task.currentTaskSession?.id || undefined,
          taskName: task.name,
          taskDescription: task.description || undefined,
          orchestrationMode: 'single',
          workingDirectory: task.workingDirectory || undefined,
          permissionConfig,
          participants: [
            {
              gatewayId: selectedParticipant.gatewayId || 'local',
              gatewayName: selectedParticipant.gatewayNameSnapshot,
              executionBackend: selectedParticipant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
              harnessType: selectedParticipant.harnessType,
              harnessLabel: selectedParticipant.harnessNameSnapshot || undefined,
              role: selectedParticipant.role,
              agentId: selectedParticipant.agentId || undefined,
              agentName: selectedParticipant.agentNameSnapshot || undefined,
              resumeSessionId: continuationSessionId,
              continuationSessionKind: continuationSessionKind || undefined,
              resumeThreadId:
                continuationSessionKind === 'codex_thread' ? continuationSessionId : undefined,
              continuationMessage: content,
            },
          ],
        },
      });

      const sourceRunTracking = readTrackingObject(parseMetadata(targetRun.controlMetadata));
      const sourceParticipantTracking = readTrackingObject(parseMetadata(selectedParticipant.controlMetadata));
      const continuationRun = await prisma.taskRun.findUnique({
        where: { id: continuationResult.taskRunId },
        include: {
          participants: true,
        },
      });
      const continuationRunParticipant =
        continuationRun?.participants.find((participant) => participant.role === selectedParticipant.role)
        ?? continuationRun?.participants[0]
        ?? null;
      const actualContinuationSession = continuationRunParticipant
        ? getContinuationSession(continuationRunParticipant)
        : { sessionId: null, sessionKind: null };
      const actualContinuationSessionId = actualContinuationSession.sessionId;
      const sameSessionConfirmed =
        !!actualContinuationSessionId && actualContinuationSessionId === continuationSessionId;
      const sessionTrackingMetadata = {
        sourceRunId: targetRun.id,
        sourceParticipantId: selectedParticipant.id,
        rootRunId: readTrackingString(sourceRunTracking, 'rootRunId') || targetRun.id,
        rootParticipantId: readTrackingString(sourceParticipantTracking, 'rootParticipantId') || selectedParticipant.id,
        rootSessionId: readTrackingString(sourceRunTracking, 'rootSessionId') || continuationSessionId,
        resumedFromSessionId: continuationSessionId,
        actualSessionId: actualContinuationSessionId,
        sessionKind: continuationSessionKind,
        rootThreadId:
          continuationSessionKind === 'codex_thread'
            ? readTrackingString(sourceRunTracking, 'rootThreadId') || continuationSessionId
            : null,
        resumedFromThreadId: continuationSessionKind === 'codex_thread' ? continuationSessionId : null,
        actualThreadId: continuationSessionKind === 'codex_thread' ? actualContinuationSessionId : null,
        latestRunId: continuationResult.taskRunId,
        latestParticipantId: continuationRunParticipant?.id ?? null,
        checkedAt: new Date().toISOString(),
        sameSessionConfirmed,
      };
      sessionTrackingResult = sessionTrackingMetadata;

      if (continuationRun) {
        await prisma.taskRun.update({
          where: { id: continuationRun.id },
          data: {
            controlMetadata: stringifyMetadata({
              ...parseMetadata(continuationRun.controlMetadata),
              sessionTracking: sessionTrackingMetadata,
            }),
          },
        });
      }

      if (continuationRunParticipant) {
        await prisma.taskRunParticipant.update({
          where: { id: continuationRunParticipant.id },
          data: {
            controlMetadata: stringifyMetadata({
              ...parseMetadata(continuationRunParticipant.controlMetadata),
              sessionTracking: sessionTrackingMetadata,
            }),
          },
        });
      }

      const finalStatus =
        continuationResult.status === 'completed'
          ? 'completed'
          : continuationResult.status === 'interrupted'
          ? 'interrupted'
          : continuationResult.status === 'stopped'
          ? 'stopped'
          : 'failed';

      await prisma.task.update({
        where: { id: task.id },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          result: JSON.stringify({
            executionMode: 'acpx',
            taskSessionId: targetRun.taskSessionId || task.currentTaskSession?.id || null,
            taskRunId: continuationResult.taskRunId,
            orchestrationMode: 'single',
            permissionConfig,
            summary: continuationResult.summary,
            participants: continuationResult.participants,
            completedAt: new Date().toISOString(),
            resumedFromSessionId: continuationSessionId,
            sessionKind: continuationSessionKind,
          }),
          error: finalStatus === 'failed' ? 'ACPX continuation failed' : null,
        },
      });

      continuationRunId = continuationResult.taskRunId;
      applied = true;
      deliveryResult = 'delivered_to_active_thread';
      systemMessage = `系统提示：这条消息已送入同一个 ${selectedParticipant.harnessType} 会话，平台已开始继续当前对话。`;

      await publishTaskRunEvent({
        taskId: task.id,
        taskRunId: continuationResult.taskRunId,
        participantId: selectedParticipant.id,
        participant: toParticipantEventPayload(selectedParticipant),
        eventType: 'session_continuation_started',
        content: `${selectedParticipant.role} 正在继续同一个 ${selectedParticipant.harnessType} 会话。`,
        metadata: {
          sourceRunId: targetRun.id,
          continuationRunId: continuationResult.taskRunId,
          controlMessageId: controlMessage.id,
          sessionId: continuationSessionId,
          sessionKind: continuationSessionKind,
          actualSessionId: actualContinuationSessionId,
          threadId: continuationSessionKind === 'codex_thread' ? continuationSessionId : null,
          actualThreadId: continuationSessionKind === 'codex_thread' ? actualContinuationSessionId : null,
          sameSessionConfirmed,
        },
      });
    } else {
      await prisma.taskRun.update({
        where: { id: targetRun.id },
        data: {
          controlState: action === 'stop_run' ? 'stop_requested' : 'interrupt_requested',
          activityState: 'terminating',
          controlMetadata: JSON.stringify({
            lastControlAction: action,
            requestedAt: new Date().toISOString(),
            roomMessageId: userMessage?.id ?? null,
          }),
        },
      });

      if (selectedParticipant && (selectedParticipant.status === 'running' || selectedParticipant.status === 'waiting_for_input')) {
        const result = requestRunControl(targetRun.id, selectedParticipant.id, action);
        applied = result.applied;
      }

      deliveryResult = applied ? 'delivered_control_signal' : 'fallback_to_queue';
      fallbackReason = applied ? null : 'no_live_local_process_available';
      fallbackAction = applied ? null : 'queue_message';
      systemMessage = applied
        ? action === 'stop_run'
          ? '系统提示：已向当前 harness 发出停止信号。'
          : '系统提示：已向当前 harness 发出立即中断信号。'
        : '系统提示：控制请求已记录，但当前没有可直接接管的运行进程，后续需要手动重新运行或等待下一阶段处理。';
    }

    const existingControlMetadata = parseMetadata(controlMessage.metadata);
    const updatedControl = await prisma.taskRunControlMessage.update({
      where: { id: controlMessage.id },
      data: {
        deliveryStatus:
          action === 'queue_message'
            ? 'pending'
            : action === 'continue_session'
            ? applied
              ? 'delivered'
              : 'rejected'
            : applied
            ? 'delivered'
            : 'pending',
        processedAt: action === 'queue_message' || applied ? new Date() : null,
        metadata: stringifyMetadata({
          ...existingControlMetadata,
          deliveryAttempted: action !== 'queue_message',
          deliveryResult,
          fallbackReason,
          fallbackAction,
          continuationRunId,
          sourceRunId: targetRun.id,
          targetRunId: targetRun.id,
          sessionTracking: sessionTrackingResult,
        }),
      },
    });

    await publishTaskRunEvent({
      taskId: task.id,
      taskRunId: targetRun.id,
      participantId: selectedParticipant?.id ?? null,
      participant: selectedParticipant ? toParticipantEventPayload(selectedParticipant) : null,
      eventType: 'control_message',
      content:
        action === 'queue_message'
          ? '收到排队消息'
          : action === 'continue_session'
          ? '收到继续当前会话请求'
          : action === 'stop_run'
          ? '收到停止运行请求'
          : '收到立即介入请求',
      metadata: {
        controlMessageId: updatedControl.id,
        controlAction: action,
        deliveryMode,
        deliveryStatus: updatedControl.deliveryStatus,
        roomMessageId: userMessage?.id ?? null,
        deliveryResult,
        fallbackReason,
        fallbackAction,
        targetParticipantId: selectedParticipant?.id ?? null,
        targetParticipantRole: selectedParticipant?.role ?? null,
        continuationSessionId,
        continuationSessionKind,
        sourceRunId: targetRun.id,
        continuationRunId,
        sessionTracking: sessionTrackingResult,
      },
    });

    await postTaskRoomMessage({
      roomId: room.id,
      content: systemMessage,
      userId: 'system',
      userName: '系统',
    });

    return NextResponse.json({
      ok: true,
      taskId: task.id,
      taskRunId: targetRun.id,
      controlMessage: {
        id: updatedControl.id,
        action: updatedControl.controlAction,
        deliveryMode: updatedControl.deliveryMode,
        deliveryStatus: updatedControl.deliveryStatus,
        participantId: updatedControl.participantId,
        roomMessageId: updatedControl.roomMessageId,
        metadata: parseMetadata(updatedControl.metadata),
      },
      applied,
      delivery: {
        result: deliveryResult,
        fallbackReason,
        fallbackAction,
      },
      sessionTracking: sessionTrackingResult,
      continuationRunId,
    });
  } catch (error) {
    console.error('Failed to process task control request:', error);
    return NextResponse.json(
      { error: 'Failed to process task control request' },
      { status: 500 }
    );
  }
}
