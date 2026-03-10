'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ChatInput from '@/components/chat/ChatInput';
import ChatMessage from '@/components/chat/ChatMessage';
import ChatSidebar from '@/components/chat/ChatSidebar';
import {
  getSocketClient,
  type ChatMessage as ChatMessageType,
  type ChatRoom,
  type ChatUser,
} from '@/lib/websocket-client';
import { matchMentionedAgents, type AgentRef } from '@/lib/mentions';

const createUserId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `user-${Math.random().toString(36).slice(2, 10)}`;
};

export default function ChatPage() {
  const socketRef = useRef<ReturnType<typeof getSocketClient> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState('general');
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [agents, setAgents] = useState<AgentRef[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  const currentRoomRef = useRef(currentRoomId);

  const currentUser = useMemo<ChatUser>(
    () => ({
      id: createUserId(),
      name: `访客-${Math.random().toString(36).slice(2, 6)}`,
    }),
    []
  );

  useEffect(() => {
    fetch('/api/agents')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setAgents(
            data.map((agent) => ({
              id: agent.id,
              name: agent.name,
              location: agent.location || 'local',
            }))
          );
        }
      })
      .catch(() => {
        setAgents([]);
      });
  }, []);

  useEffect(() => {
    currentRoomRef.current = currentRoomId;
  }, [currentRoomId]);

  useEffect(() => {
    fetch('/api/chat/rooms')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setRooms(data);
          if (data.length > 0 && !data.find((room) => room.id === currentRoomRef.current)) {
            setCurrentRoomId(data[0].id);
          }
        }
      })
      .catch(() => {
        setRooms([]);
      });
  }, []);

  useEffect(() => {
    fetch('/api/socket').catch(() => null);
    const socket = getSocketClient();
    if (!socket) return;

    socketRef.current = socket;
    socket.connect();
    socket.emit('chat:join', { user: currentUser, roomId: currentRoomRef.current });

    socket.on('chat:message', (message: ChatMessageType) => {
      if (message.roomId !== currentRoomRef.current) return;
      setMessages((prev) => [...prev, message]);
    });

    socket.on('chat:users', (list: ChatUser[]) => {
      setUsers(list);
    });

    socket.on('chat:rooms', (list: ChatRoom[]) => {
      if (Array.isArray(list)) {
        setRooms(list);
      }
    });

    return () => {
      socket.off('chat:message');
      socket.off('chat:users');
      socket.off('chat:rooms');
      socket.disconnect();
    };
  }, [currentUser]);

  useEffect(() => {
    if (!socketRef.current) return;
    socketRef.current.emit('chat:join', {
      user: currentUser,
      roomId: currentRoomId,
    });
  }, [currentRoomId, currentUser]);

  useEffect(() => {
    setHasMoreHistory(true);
    fetch(`/api/chat/messages?roomId=${currentRoomId}&limit=50`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data);
          setHasMoreHistory(data.length >= 50);
        } else {
          setMessages([]);
          setHasMoreHistory(false);
        }
      })
      .catch(() => {
        setMessages([]);
        setHasMoreHistory(false);
      });
  }, [currentRoomId]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, currentRoomId]);

  const handleSend = async (content: string) => {
    console.log('[ChatPage] handleSend called with:', content);
    const socket = socketRef.current;
    if (!socket) {
      console.error('[ChatPage] socket is null!');
      return;
    }
    console.log('[ChatPage] socket exists, emitting message');

    const message: ChatMessageType = {
      id: createUserId(),
      roomId: currentRoomId,
      user: currentUser,
      content,
      createdAt: new Date().toISOString(),
    };

    // 乐观更新：立即显示消息
    setMessages((prev) => [...prev, message]);

    const mentionedAgents = matchMentionedAgents(content, agents);
    if (mentionedAgents.length > 0) {
      console.info('Mentioned agents:', mentionedAgents);
      // 调用 Agent 响应 API
      try {
        const res = await fetch('/api/chat/agent-response', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: content, agents }),
        });
        const data = await res.json();
        if (data.responses) {
          console.info('Agent responses:', data.responses);
        }
      } catch (error) {
        console.error('Failed to get agent response:', error);
      }
    }

    socket.emit('chat:message', message);
    console.log('[ChatPage] message emitted to socket');
  };

  const handleScroll = () => {
    if (!listRef.current || !hasMoreHistory) return;
    if (listRef.current.scrollTop < 40) {
      const earliest = messages[0];
      if (!earliest) return;
      fetch(
        `/api/chat/messages?roomId=${currentRoomId}&limit=30&before=${encodeURIComponent(
          earliest.createdAt
        )}`
      )
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data) && data.length > 0) {
            setMessages((prev) => [...data, ...prev]);
            if (data.length < 30) {
              setHasMoreHistory(false);
            }
          } else {
            setHasMoreHistory(false);
          }
        })
        .catch(() => {
          setHasMoreHistory(false);
        });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">群聊</h1>
        <p className="text-gray-600 mt-2">Agent 群聊管理</p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <section className="flex h-[70vh] flex-col rounded-lg border border-gray-100 bg-gray-50 shadow-sm">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="flex-1 space-y-3 overflow-y-auto p-4"
          >
            {messages.filter((message) => message.roomId === currentRoomId).length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">
                暂无消息，开始群聊吧
              </div>
            ) : (
              messages
                .filter((message) => message.roomId === currentRoomId)
                .map((message) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    isOwn={message.user.id === currentUser.id}
                  />
                ))
            )}
          </div>
          <ChatInput onSend={handleSend} agents={agents} />
        </section>

        <ChatSidebar
          rooms={rooms.length ? rooms : [{ id: 'general', name: '大厅' }]}
          currentRoomId={currentRoomId}
          onSelectRoom={setCurrentRoomId}
          users={users}
        />
      </div>
    </div>
  );
}
