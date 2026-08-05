import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import type { AcpxLiveEventPayload, TaskRunEventTier, TaskRunEventType, TaskRunStream } from './types';

const TASK_RUN_ROOM_PREFIX = 'task-run';

export const getTaskRunRoom = (taskId: string) => `${TASK_RUN_ROOM_PREFIX}:${taskId}`;
const DETAIL_EVENT_TYPES: Set<TaskRunEventType> = new Set<TaskRunEventType>(['stdout_chunk', 'stderr_chunk']);

const computeTier = (eventType: TaskRunEventType): TaskRunEventTier =>
  DETAIL_EVENT_TYPES.has(eventType) ? 'detail' : 'summary';


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
      tier: computeTier(eventType),
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
    tier: (event as any).tier || computeTier(eventType),
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
