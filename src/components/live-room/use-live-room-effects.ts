import { useEffect } from 'react';
import { ensureSocketServerReady, getSocketClient } from '@/lib/websocket-client';
import type { LiveRoomMessage, WorkspaceSummary } from '@/types';
import {
  DETAILS_PANEL_KEY,
  DISABLE_LIVE_ROOM_SOCKET_AND_POLLING,
  ROOMS_PANEL_KEY,
} from './live-room-workspace-models';
import type { LiveRoomState } from './use-live-room-state';

/* eslint-disable react-hooks/exhaustive-deps -- preserve the original workspace effect dependencies after extraction */

type RefreshRooms = (options?: { background?: boolean }) => Promise<void>;
type RefreshSelectedRoom = (
  roomId: string,
  options?: { background?: boolean; preserveComposerState?: boolean }
) => Promise<void>;

export function useLiveRoomEffects({
  state,
  initialRoomId,
  basePath,
  router,
  pendingSummaryText,
  refreshRooms,
  refreshSelectedRoom,
}: {
  state: LiveRoomState;
  initialRoomId?: string;
  basePath: string;
  router: { push: (href: string) => void };
  pendingSummaryText: string | null;
  refreshRooms: RefreshRooms;
  refreshSelectedRoom: RefreshSelectedRoom;
}) {
  const {
    selectedRoom, messages, isRoomsPanelOpen, isDetailsPanelOpen, isSocketConnected,
    notice, dismissedNotice, dismissedPendingSummary, messageViewportRef,
    shouldStickToBottomRef, setRooms, setSelectedRoom, setMessages,
    setIsRoomsPanelOpen, setIsDetailsPanelOpen, setIsSocketConnected,
    setDismissedNotice, setDismissedPendingSummary,
  } = state;

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storedRoomsPanel = window.localStorage.getItem(ROOMS_PANEL_KEY);
    const storedDetailsPanel = window.localStorage.getItem(DETAILS_PANEL_KEY);
    setIsRoomsPanelOpen(storedRoomsPanel !== 'false');
    setIsDetailsPanelOpen(storedDetailsPanel !== 'false');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(ROOMS_PANEL_KEY, String(isRoomsPanelOpen));
  }, [isRoomsPanelOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DETAILS_PANEL_KEY, String(isDetailsPanelOpen));
  }, [isDetailsPanelOpen]);

  useEffect(() => {
    if (initialRoomId) {
      shouldStickToBottomRef.current = true;
      void refreshSelectedRoom(initialRoomId);
      return;
    }

    setSelectedRoom(null);
    setMessages([]);
  }, [initialRoomId]);

  useEffect(() => {
    if (!selectedRoom?.id || !selectedRoom.pendingReplyCount || selectedRoom.pendingReplyCount <= 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void refreshSelectedRoom(selectedRoom.id, {
        background: true,
        preserveComposerState: true,
      });
      void refreshRooms({ background: true });
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedRoom?.id, selectedRoom?.pendingReplyCount]);

  useEffect(() => {
    if (!dismissedNotice) {
      return;
    }

    if (notice !== dismissedNotice) {
      setDismissedNotice(null);
    }
  }, [dismissedNotice, notice]);

  useEffect(() => {
    if (!dismissedPendingSummary) {
      return;
    }

    if (pendingSummaryText !== dismissedPendingSummary) {
      setDismissedPendingSummary(null);
    }
  }, [dismissedPendingSummary, pendingSummaryText]);

  useEffect(() => {
    if (DISABLE_LIVE_ROOM_SOCKET_AND_POLLING) {
      setIsSocketConnected(false);
      return;
    }

    const socket = getSocketClient();
    if (!socket) {
      return;
    }

    let cancelled = false;

    const handleMessage = (message: LiveRoomMessage) => {
      if (message.roomId !== initialRoomId) {
        return;
      }

      setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
    };

    const handleRoomUpdated = (summary: WorkspaceSummary) => {
      setRooms((prev) => {
        const next = prev.some((room) => room.id === summary.id)
          ? prev.map((room) => room.id === summary.id ? summary : room)
          : [summary, ...prev];
        return [...next].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });

      if (summary.id === initialRoomId) {
        setSelectedRoom((current) => current && current.id === summary.id
          ? {
              ...current,
              title: summary.title,
              description: summary.description,
              currentTopic: summary.currentTopic,
              mode: summary.mode,
              status: summary.status,
              createdBy: summary.createdBy,
              createdAt: summary.createdAt,
              updatedAt: summary.updatedAt,
              currentSpeakerMemberId: summary.currentSpeakerMemberId,
              currentSpeakerName: summary.currentSpeakerName,
              memberCount: summary.memberCount,
              lastMessagePreview: summary.lastMessagePreview,
              lastMessageAt: summary.lastMessageAt,
            }
          : current);
      }
    };

    const handleRoomDeleted = ({ roomId }: { roomId: string }) => {
      setRooms((prev) => prev.filter((room) => room.id !== roomId));

      if (roomId === initialRoomId) {
        setSelectedRoom(null);
        setMessages([]);
        router.push(basePath);
      }
    };

    const handleConnect = () => {
      setIsSocketConnected(true);
    };

    const handleDisconnect = () => {
      setIsSocketConnected(false);
    };

    const connectSocket = async () => {
      await ensureSocketServerReady();
      if (cancelled) {
        return;
      }

      if (!socket.connected) {
        socket.connect();
      } else {
        setIsSocketConnected(true);
      }

      if (initialRoomId) {
        socket.emit('live-room:join', { roomId: initialRoomId });
      }

      socket.on('connect', handleConnect);
      socket.on('disconnect', handleDisconnect);
      socket.on('live-room:message', handleMessage);
      socket.on('live-room:updated', handleRoomUpdated);
      socket.on('live-room:deleted', handleRoomDeleted);
    };

    void connectSocket();

    return () => {
      cancelled = true;
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('live-room:message', handleMessage);
      socket.off('live-room:updated', handleRoomUpdated);
      socket.off('live-room:deleted', handleRoomDeleted);
    };
  }, [basePath, initialRoomId, router]);

  useEffect(() => {
    if (DISABLE_LIVE_ROOM_SOCKET_AND_POLLING) {
      return;
    }

    if (isSocketConnected) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void refreshRooms();
      if (initialRoomId) {
        void refreshSelectedRoom(initialRoomId, {
          background: true,
          preserveComposerState: true,
        });
      }
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [initialRoomId, isSocketConnected]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    if (!shouldStickToBottomRef.current) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);
}
