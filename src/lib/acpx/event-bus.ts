import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import type { AcpxLiveEventPayload, TaskRunEventType, TaskRunStream } from './types';

const TASK_RUN_ROOM_PREFIX = 'task-run';

export const getTaskRunRoom = (taskId: string) => `${TASK_RUN_ROOM_PREFIX}:${taskId}`;

const parseMetadata = (metadata?: Record<string, unknown> | null) =>
  metadata ? JSON.stringify(metadata) : null;

export const publishTaskRunEvent = async ({
  taskId,
  taskRunId,
  participantId,
  participant,
  eventType,
  stream = 'system',
  content,
  metadata,
}: {
  taskId: string;
  taskRunId: string;
  participantId?: string | null;
  participant?: AcpxLiveEventPayload['participant'];
  eventType: TaskRunEventType;
  stream?: TaskRunStream;
  content: string;
  metadata?: Record<string, unknown> | null;
}): Promise<AcpxLiveEventPayload> => {
  const latestEvent = await prisma.taskRunEvent.findFirst({
    where: { taskRunId },
    orderBy: { sequence: 'desc' },
  });

  const event = await prisma.taskRunEvent.create({
    data: {
      taskRunId,
      participantId: participantId || null,
      sequence: (latestEvent?.sequence ?? 0) + 1,
      eventType,
      stream,
      content,
      metadata: parseMetadata(metadata),
    },
  });

  const payload: AcpxLiveEventPayload = {
    id: event.id,
    taskId,
    taskRunId,
    participantId: event.participantId,
    participant: participant ?? null,
    sequence: event.sequence,
    eventType,
    stream,
    content,
    metadata: metadata ?? null,
    createdAt: event.createdAt.toISOString(),
  };

  const io = getSocketServer();
  if (io) {
    io.to(getTaskRunRoom(taskId)).emit('task-run:event', payload);
  }

  return payload;
};
