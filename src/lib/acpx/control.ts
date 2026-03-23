import { prisma } from '@/lib/prisma';
import type { TaskRunControlMessageDraft } from './types';

const stringifyMetadata = (metadata?: Record<string, unknown> | null) =>
  metadata ? JSON.stringify(metadata) : null;

export const createTaskRunControlMessage = async (draft: TaskRunControlMessageDraft) =>
  prisma.taskRunControlMessage.create({
    data: {
      taskId: draft.taskId,
      taskSessionId: draft.taskSessionId ?? null,
      taskRunId: draft.taskRunId,
      roomMessageId: draft.roomMessageId ?? null,
      participantId: draft.participantId ?? null,
      senderUserId: draft.senderUserId,
      senderName: draft.senderName,
      deliveryMode: draft.deliveryMode,
      deliveryStatus: draft.deliveryStatus ?? 'pending',
      controlAction: draft.controlAction,
      content: draft.content,
      metadata: stringifyMetadata(draft.metadata),
    },
  });
