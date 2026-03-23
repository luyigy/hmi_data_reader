import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createTaskRunControlMessage } from '@/lib/acpx/control';
import { requestRunControl } from '@/lib/acpx/process-registry';
import { publishTaskRunEvent } from '@/lib/acpx/event-bus';
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
} from '@/lib/acpx/types';
import type { ChatMessageTargetType } from '@/lib/chat-types';

export const dynamic = 'force-dynamic';

const USER_ID = 'task-room-user';
const USER_NAME = '用户';

const isControlAction = (value: unknown): value is RunControlAction =>
  value === 'queue_message' || value === 'interrupt_now' || value === 'stop_run';

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

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
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

    if ((action === 'queue_message' || action === 'interrupt_now') && !content) {
      return NextResponse.json(
        { error: 'Message content is required for queue_message and interrupt_now' },
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

    if ((action === 'interrupt_now' || action === 'stop_run') && !targetRun) {
      return NextResponse.json(
        { error: 'No task run available for this control action' },
        { status: 400 }
      );
    }

    const selectedParticipant = participantId
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
      },
    });

    let applied = false;
    let systemMessage = '';

    if (action === 'queue_message') {
      systemMessage = '系统提示：这条消息已作为排队指令记录，当前 run 不会被强制打断，下一次合适的 handoff 或 rerun 会看到它。';
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

      if (
        selectedParticipant?.executionBackend === 'platform_local'
        && (selectedParticipant.status === 'running' || selectedParticipant.status === 'waiting_for_input')
      ) {
        const result = requestRunControl(targetRun.id, selectedParticipant.id, action);
        applied = result.applied;
      }

      systemMessage = applied
        ? action === 'stop_run'
          ? '系统提示：已向本地 harness 发出停止信号。'
          : '系统提示：已向本地 harness 发出立即中断信号。'
        : '系统提示：控制请求已记录，但当前没有可直接接管的本地运行进程，后续需要手动重新运行或等待下一阶段处理。';
    }

    const updatedControl = await prisma.taskRunControlMessage.update({
      where: { id: controlMessage.id },
      data: {
        deliveryStatus: action === 'queue_message' ? 'pending' : applied ? 'delivered' : 'pending',
        processedAt: action === 'queue_message' || applied ? new Date() : null,
      },
    });

    await publishTaskRunEvent({
      taskId: task.id,
      taskRunId: targetRun.id,
      participantId: selectedParticipant?.id ?? null,
      participant: selectedParticipant
        ? {
            gatewayId: selectedParticipant.gatewayId,
            gatewayName: selectedParticipant.gatewayNameSnapshot,
            executionBackend: selectedParticipant.executionBackend as 'platform_local' | 'gateway_openclaw',
            harnessType: selectedParticipant.harnessType,
            harnessLabel: selectedParticipant.harnessNameSnapshot,
            role: selectedParticipant.role,
            agentId: selectedParticipant.agentId,
            agentName: selectedParticipant.agentNameSnapshot,
          }
        : null,
      eventType: 'control_message',
      content:
        action === 'queue_message'
          ? '收到排队消息'
          : action === 'stop_run'
          ? '收到停止运行请求'
          : '收到立即介入请求',
      metadata: {
        controlMessageId: updatedControl.id,
        controlAction: action,
        deliveryMode,
        deliveryStatus: updatedControl.deliveryStatus,
        roomMessageId: userMessage?.id ?? null,
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
      },
      applied,
    });
  } catch (error) {
    console.error('Failed to process task control request:', error);
    return NextResponse.json(
      { error: 'Failed to process task control request' },
      { status: 500 }
    );
  }
}
