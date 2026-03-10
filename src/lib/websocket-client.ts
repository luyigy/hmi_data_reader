import { io as createClient, type Socket } from 'socket.io-client';
import type { ChatMessage, ChatRoom, ChatUser } from '@/lib/chat-types';

export type { ChatMessage, ChatRoom, ChatUser };

const SOCKET_PATH = '/api/socket';

let clientSocket: Socket | null = null;

export const getSocketClient = () => {
  if (typeof window === 'undefined') return null;

  if (!clientSocket) {
    const port = process.env.NEXT_PUBLIC_SOCKET_PORT;
    const baseUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      (port
        ? `${window.location.protocol}//${window.location.hostname}:${port}`
        : window.location.origin);

    clientSocket = createClient(baseUrl, {
      path: SOCKET_PATH,
      autoConnect: false,
    });
  }

  return clientSocket;
};
