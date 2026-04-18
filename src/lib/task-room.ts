import { prisma } from '@/lib/prisma';
import { getSocketServer } from '@/lib/websocket';
import type { ChatMessageTargetType } from '@/lib/chat-types';
import { formatTaskRoomMessageTargetPrefix } from './task-room-targets';

const TASK_ROOM_MARKER_PREFIX = 'TASK_ROOM:';
const TASK_ROOM_PROMPT_MESSAGE_LIMIT = 12;
const TASK_ROOM_PROMPT_CHAR_LIMIT = 4000;

const RAW_HARNESS_OUTPUT_PATTERNS = [
  /^\{"type":"thread\.started"/,
  /^\{"type":"turn\.started"/,
  /^\{"type":"result","subtype":"error_during_execution"/,
  /^\{"type":"error","message":/m,
  /^\{"type":"turn\.failed"/m,
];

const shouldIncludeTaskRoomPromptMessage = (message: {
  userId: string;
  userName: string;
  content: string;
}) => {
  if (message.userId === 'system') {
    return false;
  }

  if (message.userName === '系统') {
    return false;
  }

  const content = message.content.trim();
  if (!content) {
    return false;
  }

  return !RAW_HARNESS_OUTPUT_PATTERNS.some((pattern) => pattern.test(content));
};

const trimTaskRoomTranscript = (value: string) =>
  value.length > TASK_ROOM_PROMPT_CHAR_LIMIT
    ? value.slice(value.length - TASK_ROOM_PROMPT_CHAR_LIMIT)
    : value;

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

export const countTaskRoomMessages = async (taskId: string, taskName: string) => {
  const room = await findTaskChatRoom(taskId, taskName);
  if (!room) return 0;
  return prisma.message.count({ where: { roomId: room.id } });
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
  const contextMessages = messages.filter(shouldIncludeTaskRoomPromptMessage);

  if (contextMessages.length === 0) {
    return '';
  }

  return trimTaskRoomTranscript(contextMessages
    .map((message) => {
      const timestamp = message.createdAt.toLocaleString('zh-CN', { hour12: false });
      const targetPrefix = formatTaskRoomMessageTargetPrefix({
        targetType: message.targetType,
        targetParticipantLabel: message.targetParticipantLabel,
      });

      return `[${timestamp}] ${message.userName}: ${targetPrefix}${message.content}`;
    })
    .join('\n'));
};

export const buildTaskRoomPromptContext = async (taskId: string, taskName: string, limit = 20) => {
  const { messages } = await getTaskRoomMessages(taskId, taskName, limit);
  const promptCandidates = messages.filter(shouldIncludeTaskRoomPromptMessage);
  const contextMessages = promptCandidates.slice(-TASK_ROOM_PROMPT_MESSAGE_LIMIT);

  const debugLog = process.env.DEBUG_MENTION_DETECTION === 'true';

  if (debugLog) {
    console.log('[Task Room Context] Total messages:', messages.length);
    console.log('[Task Room Context] Filtered messages (non-system):', contextMessages.length);
  }

  if (contextMessages.length === 0) {
    return {
      transcript: '',
      latestUserMessage: null,
    };
  }

  const transcript = trimTaskRoomTranscript(contextMessages
    .map((message) => {
      const timestamp = message.createdAt.toLocaleString('zh-CN', { hour12: false });
      const targetPrefix = formatTaskRoomMessageTargetPrefix({
        targetType: message.targetType,
        targetParticipantLabel: message.targetParticipantLabel,
      });

      return `[${timestamp}] ${message.userName}: ${targetPrefix}${message.content}`;
    })
    .join('\n'));

  const latestUserMessage = [...contextMessages]
    .reverse()
    .find((message) => message.userId === 'task-room-user');

  const result = {
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

  if (debugLog) {
    console.log('[Task Room Context] Latest user message:', result.latestUserMessage?.content || 'none');
    console.log('[Task Room Context] Transcript length:', transcript.length);
    if (result.latestUserMessage?.content?.startsWith('@')) {
      console.warn('[Task Room Context] WARNING: Latest user message still starts with @mention!');
    }
  }

  return result;
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

/**
 * 清空 Task Room 的所有历史消息
 * 用于清理无关的历史上下文，确保 agent 只收到当前任务相关的消息
 */
export const clearTaskRoomMessages = async (taskId: string, taskName: string) => {
  const room = await findTaskChatRoom(taskId, taskName);
  if (!room) {
    return { success: false, message: 'Task room not found' };
  }

  const deleteResult = await prisma.message.deleteMany({
    where: {
      roomId: room.id,
    },
  });

  const debugLog = process.env.DEBUG_MENTION_DETECTION === 'true';
  if (debugLog) {
    console.log('[Task Room] Cleared messages:', {
      taskId,
      taskName,
      roomId: room.id,
      deletedCount: deleteResult.count,
    });
  }

  // 通知所有连接的客户端消息已被清空
  const io = getSocketServer();
  if (io) {
    io.to(room.id).emit('chat:messages_cleared', {
      roomId: room.id,
      clearedAt: new Date().toISOString(),
    });
  }

  return {
    success: true,
    message: `Cleared ${deleteResult.count} messages from task room`,
    roomId: room.id,
    deletedCount: deleteResult.count,
  };
};
