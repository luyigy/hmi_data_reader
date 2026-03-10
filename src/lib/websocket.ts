import { createServer, type Server as HTTPServer } from 'http';
import { Server as IOServer } from 'socket.io';
import { prisma } from '@/lib/prisma';
import { ensureDefaultRooms } from '@/lib/chat';
import type { ChatMessage, ChatUser } from '@/lib/chat-types';
import type { AgentResponse } from '@/lib/agent-responder';

const SOCKET_PATH = '/api/socket';
const DEFAULT_PORT = Number(process.env.SOCKET_PORT ?? 3001);

const globalForSocket = globalThis as unknown as {
  io?: IOServer;
  onlineUsers?: Map<string, ChatUser>;
};

const getOnlineUsersStore = () => {
  if (!globalForSocket.onlineUsers) {
    globalForSocket.onlineUsers = new Map();
  }
  return globalForSocket.onlineUsers;
};

const setupSocketEvents = (io: IOServer) => {
  const onlineUsers = getOnlineUsersStore();

  io.on('connection', async (socket) => {
    try {
      await ensureDefaultRooms();
      const rooms = await prisma.chatRoom.findMany({
        orderBy: { createdAt: 'asc' },
      });
      socket.emit('chat:rooms', rooms);
    } catch (error) {
      console.error('Failed to load chat rooms:', error);
    }

    socket.on('chat:join', ({ user, roomId }: { user: ChatUser; roomId: string }) => {
      if (roomId) {
        socket.join(roomId);
      }
      onlineUsers.set(socket.id, user);
      io.emit('chat:users', Array.from(onlineUsers.values()));
    });

    socket.on('chat:message', async (message: ChatMessage) => {
      if (!message.roomId) return;
      try {
        const stored = await prisma.message.create({
          data: {
            content: message.content,
            roomId: message.roomId,
            userId: message.user.id,
            userName: message.user.name,
          },
        });

        const payload: ChatMessage = {
          id: stored.id,
          roomId: stored.roomId,
          user: { id: stored.userId, name: stored.userName },
          content: stored.content,
          createdAt: stored.createdAt.toISOString(),
        };

        if (payload.roomId) {
          io.to(payload.roomId).emit('chat:message', payload);
          return;
        }
        io.emit('chat:message', payload);
      } catch (error) {
        console.error('Failed to persist message:', error);
      }
    });

    socket.on('chat:agent-response', async (response: AgentResponse) => {
      // 持久化 Agent 响应消息
      try {
        const stored = await prisma.message.create({
          data: {
            content: response.response,
            roomId: 'general', // 默认房间，实际应该从消息中获取
            userId: response.agentId,
            userName: response.agentName,
          },
        });

        const payload: ChatMessage = {
          id: stored.id,
          roomId: stored.roomId,
          user: { id: stored.userId, name: stored.userName },
          content: stored.content,
          createdAt: stored.createdAt.toISOString(),
        };

        if (payload.roomId) {
          io.to(payload.roomId).emit('chat:message', payload);
        }
      } catch (error) {
        console.error('Failed to persist agent response:', error);
      }
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id);
      io.emit('chat:users', Array.from(onlineUsers.values()));
    });
  });
};

export const initSocketServer = (server?: HTTPServer) => {
  if (globalForSocket.io) {
    return globalForSocket.io;
  }

  let io: IOServer;

  if (server) {
    io = new IOServer(server, {
      path: SOCKET_PATH,
      cors: {
        origin: '*',
      },
    });
  } else {
    const httpServer = createServer((_, res) => {
      res.statusCode = 200;
      res.end('Socket server running');
    });

    io = new IOServer(httpServer, {
      path: SOCKET_PATH,
      cors: {
        origin: '*',
      },
    });

    httpServer.listen(DEFAULT_PORT);
  }

  setupSocketEvents(io);
  globalForSocket.io = io;

  return io;
};

