import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import type { ChatMessageTargetType } from '@/lib/chat-types';
import { formatTaskRoomMessageTargetPrefix } from './task-room-targets';

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
      const targetPrefix = formatTaskRoomMessageTargetPrefix({
        targetType: message.targetType,
        targetParticipantLabel: message.targetParticipantLabel,
      });

      return `[${timestamp}] ${message.userName}: ${targetPrefix}${message.content}`;
    })
    .join('\n');
};

export const buildTaskRoomPromptContext = async (taskId: string, taskName: string, limit = 20) => {
  const { messages } = await getTaskRoomMessages(taskId, taskName, limit);
  const contextMessages = messages.filter((message) => message.userId !== 'system');

  if (contextMessages.length === 0) {
    return {
      transcript: '',
      latestUserMessage: null,
    };
  }

  const transcript = contextMessages
    .map((message) => {
      const timestamp = message.createdAt.toLocaleString('zh-CN', { hour12: false });
      const targetPrefix = formatTaskRoomMessageTargetPrefix({
        targetType: message.targetType,
        targetParticipantLabel: message.targetParticipantLabel,
      });

      return `[${timestamp}] ${message.userName}: ${targetPrefix}${message.content}`;
    })
    .join('\n');

  const latestUserMessage = [...contextMessages]
    .reverse()
    .find((message) => message.userId === 'task-room-user');

  return {
    transcript,
    latestUserMessage: latestUserMessage
      ? {
          id: latestUserMessage.id,
          content: latestUserMessage.content,
          createdAt: latestUserMessage.createdAt.toISOString(),
          targetType: latestUserMessage.targetType as ChatMessageTargetType,
          targetParticipantLabel: latestUserMessage.targetParticipantLabel,
        }
      : null,
  };
};

export const postTaskRoomMessage = async ({
  roomId,
  content,
  userId,
  userName,
  targetType = 'task',
  targetParticipantKey,
  targetParticipantLabel,
}: {
  roomId: string;
  content: string;
  userId: string;
  userName: string;
  targetType?: ChatMessageTargetType;
  targetParticipantKey?: string | null;
  targetParticipantLabel?: string | null;
}) => {
  const message = await prisma.message.create({
    data: {
      roomId,
      content,
      userId,
      userName,
      targetType,
      targetParticipantKey: targetType === 'participant' ? (targetParticipantKey ?? null) : null,
      targetParticipantLabel: targetType === 'participant' ? (targetParticipantLabel ?? null) : null,
    },
  });

  const io = getSocketServer();
  if (io) {
    io.to(roomId).emit('chat:message', {
      id: message.id,
      roomId: message.roomId,
      user: {
        id: message.userId,
        name: message.userName,
      },
      content: message.content,
      target: {
        type: message.targetType as ChatMessageTargetType,
        participantKey: message.targetParticipantKey,
        participantLabel: message.targetParticipantLabel,
      },
      createdAt: message.createdAt.toISOString(),
    });
  }

  return message;
};
