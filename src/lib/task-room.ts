import { prisma } from '@/lib/prisma';

const TASK_ROOM_MARKER_PREFIX = 'TASK_ROOM:';

export const getTaskRoomName = (taskName: string) => `任务：${taskName}`;

const getTaskRoomMarker = (taskId: string) => `${TASK_ROOM_MARKER_PREFIX}${taskId}`;

export const findTaskChatRoom = async (taskId: string, taskName: string) => {
  const marker = getTaskRoomMarker(taskId);

  return prisma.chatRoom.findFirst({
    where: {
      OR: [
        {
          description: {
            contains: marker,
          },
        },
        {
          name: getTaskRoomName(taskName),
        },
      ],
    },
    orderBy: {
      createdAt: 'asc',
    },
  });
};

export const ensureTaskChatRoom = async (taskId: string, taskName: string) => {
  const existing = await findTaskChatRoom(taskId, taskName);
  if (existing) {
    if (!(existing.description || '').includes(getTaskRoomMarker(taskId))) {
      return prisma.chatRoom.update({
        where: { id: existing.id },
        data: {
          description: `${getTaskRoomMarker(taskId)}\n${existing.description || '任务执行聊天室'}`,
        },
      });
    }

    return existing;
  }

  return prisma.chatRoom.create({
    data: {
      name: getTaskRoomName(taskName),
      description: `${getTaskRoomMarker(taskId)}\n任务执行聊天室 - ${new Date().toLocaleString('zh-CN')}`,
    },
  });
};

export const getTaskRoomMessages = async (taskId: string, taskName: string, limit = 50) => {
  const room = await ensureTaskChatRoom(taskId, taskName);
  const messages = await prisma.message.findMany({
    where: {
      roomId: room.id,
    },
    orderBy: {
      createdAt: 'asc',
    },
    take: limit,
  });

  return {
    room,
    messages,
  };
};

export const buildTaskRoomContext = async (taskId: string, taskName: string, limit = 20) => {
  const { messages } = await getTaskRoomMessages(taskId, taskName, limit);
  const contextMessages = messages.filter((message) => message.userId !== 'system');

  if (contextMessages.length === 0) {
    return '';
  }

  return contextMessages
    .map((message) => {
      const timestamp = message.createdAt.toLocaleString('zh-CN', { hour12: false });
      return `[${timestamp}] ${message.userName}: ${message.content}`;
    })
    .join('\n');
};
