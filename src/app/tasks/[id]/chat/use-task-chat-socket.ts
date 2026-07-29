'use client';

import { useEffect } from 'react';
import { getSocketClient, type ChatMessage } from '@/lib/websocket-client';
import type { TaskRunEvent } from './task-chat-types';
import { taskRoomUser } from './task-chat-types';
import type { TaskChatState } from './use-task-chat-state';

export const useTaskChatSocket = (state: TaskChatState) => {
  const { task, taskRoom, pollingRef, setRoomMessages, runSummariesRef, setRunSummaries,
    setSelectedRun, selectedRunId, setSelectedRunId, fetchSelectedRun, setIsExecuting,
    fetchTaskInfo, fetchRuns, setSocketUnavailableReason, setIsConnected, taskId,
    fetchRoomMessages, fetchStandardLogs } = state;
  useEffect(() => {
    if (!task || !taskRoom) {
      return;
    }

    let disposed = false;
    let fallbackPollingStarted = false;

    const startFallbackPolling = () => {
      if (fallbackPollingStarted || pollingRef.current) {
        return;
      }

      fallbackPollingStarted = true;
      pollingRef.current = setInterval(() => {
        void fetchRoomMessages(taskRoom.id);
        if (task.executionMode === 'acpx') {
          void fetchRuns();
          if (selectedRunId) {
            void fetchSelectedRun(selectedRunId);
          }
        } else {
          void fetchStandardLogs();
        }
      }, 4000);
    };

    const handleChatMessage = (message: ChatMessage) => {
      if (message.roomId !== taskRoom.id) {
        return;
      }

      setRoomMessages((prev) => {
        if (prev.some((item) => item.id === message.id)) {
          return prev;
        }
        return [...prev, message];
      });
    };

    const handleRunEvent = (event: TaskRunEvent) => {
      const controlRunStatus =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.runStatus === 'string'
          ? event.metadata.runStatus
          : null;
      const controlActivityState =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.activityState === 'string'
          ? event.metadata.activityState
          : null;
      const isNewRun = !runSummariesRef.current.some((run) => run.id === event.taskRunId);

      setRunSummaries((prev) => {
        const existing = prev.find((run) => run.id === event.taskRunId);
        if (!existing) {
          return [
            {
              id: event.taskRunId,
              mode: 'acpx',
              orchestrationMode: 'staged',
              status:
                controlRunStatus
                  ? controlRunStatus
                  : event.eventType === 'run_completed'
                  ? 'completed'
                  : event.eventType === 'run_interrupted'
                  ? 'interrupted'
                  : event.eventType === 'run_stopped'
                  ? 'stopped'
                  : event.eventType === 'run_failed'
                  ? 'failed'
                  : 'running',
              activityState: controlActivityState || 'quiet',
              summary: null,
              error: null,
              startedAt: event.createdAt,
              completedAt: null,
              createdAt: event.createdAt,
              participants: [],
            },
            ...prev,
          ];
        }

        return prev.map((run) =>
          run.id === event.taskRunId
            ? {
                ...run,
                status:
                  controlRunStatus
                    ? controlRunStatus
                    : event.eventType === 'run_completed'
                    ? 'completed'
                    : event.eventType === 'run_interrupted'
                    ? 'interrupted'
                    : event.eventType === 'run_stopped'
                    ? 'stopped'
                    : event.eventType === 'run_failed'
                    ? 'failed'
                    : run.status,
                activityState: controlActivityState || run.activityState,
              }
            : run
        );
      });

      setSelectedRun((prev) => {
        if (!prev || prev.id !== event.taskRunId) {
          return prev;
        }

        if (prev.events.some((item) => item.id === event.id)) {
          return prev;
        }

        return {
          ...prev,
          status:
            controlRunStatus
              ? controlRunStatus
              : event.eventType === 'run_completed'
              ? 'completed'
              : event.eventType === 'run_interrupted'
              ? 'interrupted'
              : event.eventType === 'run_stopped'
              ? 'stopped'
              : event.eventType === 'run_failed'
              ? 'failed'
              : prev.status,
          activityState: controlActivityState || prev.activityState,
          events: [...prev.events, event].sort((a, b) => a.sequence - b.sequence),
        };
      });

      if (!selectedRunId) {
        setSelectedRunId(event.taskRunId);
      }

      if (isNewRun) {
        setSelectedRunId(event.taskRunId);
        void fetchSelectedRun(event.taskRunId);
      }

      if (
        event.eventType === 'run_completed'
        || event.eventType === 'run_failed'
        || event.eventType === 'run_interrupted'
        || event.eventType === 'run_stopped'
        || event.eventType === 'control_message'
      ) {
        setIsExecuting(false);
        void fetchTaskInfo();
        void fetchRuns(isNewRun ? event.taskRunId : selectedRunId);
        if (!selectedRunId || selectedRunId === event.taskRunId) {
          void fetchSelectedRun(event.taskRunId);
        }
      }
    };

    const bootstrapSocket = async () => {
      try {
        const response = await fetch('/api/socket');
        const bootstrap = await response.json().catch(() => null);

        if (disposed) {
          return;
        }

        if (!bootstrap?.liveSocketAvailable) {
          setSocketUnavailableReason(
            typeof bootstrap?.reason === 'string'
              ? bootstrap.reason
              : '实时 socket 当前不可用，已切换为轮询刷新。'
          );
          setIsConnected(false);
          startFallbackPolling();
          return;
        }

        const socket = getSocketClient();
        if (!socket) {
          setSocketUnavailableReason('浏览器侧 socket client 不可用，已切换为轮询刷新。');
          setIsConnected(false);
          startFallbackPolling();
          return;
        }

        if (!socket.connected) {
          socket.connect();
        }

        socket.emit('chat:join', { user: taskRoomUser, roomId: taskRoom.id });

        if (task.executionMode === 'acpx') {
          socket.emit('task-run:join', { taskId });
        }

        setSocketUnavailableReason(null);
        setIsConnected(true);
        socket.on('chat:message', handleChatMessage);
        socket.on('task-run:event', handleRunEvent);
      } catch (error) {
        if (disposed) {
          return;
        }

        console.error('Failed to bootstrap socket:', error);
        setSocketUnavailableReason('实时连接初始化失败，已切换为轮询刷新。');
        setIsConnected(false);
        startFallbackPolling();
      }
    };

    void bootstrapSocket();

    return () => {
      disposed = true;
      const socket = getSocketClient();
      socket?.off('chat:message', handleChatMessage);
      socket?.off('task-run:event', handleRunEvent);
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [task, taskRoom, taskId, selectedRunId]);


};
