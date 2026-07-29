'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { ChatMessage } from '@/lib/websocket-client';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import type { ConversationMode, SelectedRunResponse, StandardLogMessage, TaskInfo, TaskRoomInfo, TaskRunSummary } from './task-chat-types';

export const useTaskChatState = () => {
  const params = useParams();
  const taskId = params.id as string;
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [taskRoom, setTaskRoom] = useState<TaskRoomInfo | null>(null);
  const [roomMessages, setRoomMessages] = useState<ChatMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [messageTargetType, setMessageTargetType] = useState<'task' | 'participant' | 'all'>('task');
  const [messageTargetParticipantKey, setMessageTargetParticipantKey] = useState('');
  const [standardMessages, setStandardMessages] = useState<StandardLogMessage[]>([]);
  const [runSummaries, setRunSummaries] = useState<TaskRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<SelectedRunResponse['latestRun']>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [socketUnavailableReason, setSocketUnavailableReason] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [participantProbeState, setParticipantProbeState] = useState<Record<string, {
    status: 'idle' | 'testing' | 'success' | 'error';
    message?: string;
  }>>({});
  const [permissionConfig, setPermissionConfig] = useState<AcpxPermissionConfig>(DEFAULT_ACPX_PERMISSION_CONFIG);
  const [isPermissionEditorOpen, setIsPermissionEditorOpen] = useState(false);
  const [isSavingPermissionConfig, setIsSavingPermissionConfig] = useState(false);
  const [permissionConfigNotice, setPermissionConfigNotice] = useState<string | null>(null);
  const [conversationMode, setConversationMode] = useState<ConversationMode>('chat');
  const [isRoomDetailsOpen, setIsRoomDetailsOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [isRunHistoryOpen, setIsRunHistoryOpen] = useState(true);
  const [isSelectedSummaryOpen, setIsSelectedSummaryOpen] = useState(true);
  const [isParticipantOutcomesOpen, setIsParticipantOutcomesOpen] = useState(true);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const runSummariesRef = useRef<TaskRunSummary[]>([]);

  useEffect(() => {
    void fetchTaskInfo();

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [taskId]);

  useEffect(() => {
    if (!task) {
      return;
    }

    if (task.executionMode === 'acpx') {
      setPermissionConfig(task.acpxPermissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG);
    }

    void fetchTaskRoom();

    if (task.executionMode === 'acpx') {
      void fetchRuns();
      return;
    }

    void fetchStandardLogs();
    pollingRef.current = setInterval(() => {
      void fetchStandardLogs();
    }, 2000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [task]);

  useEffect(() => {
    if (!taskRoom) {
      return;
    }

    void fetchRoomMessages(taskRoom.id);
  }, [taskRoom]);

  useEffect(() => {
    if (!task || task.executionMode !== 'acpx') {
      return;
    }

    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }

    void fetchSelectedRun(selectedRunId);
  }, [selectedRunId, task]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
  }, [selectedRunId]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      return;
    }

    const container = timelineContainerRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [roomMessages, selectedRun, standardMessages]);

  useEffect(() => {
    runSummariesRef.current = runSummaries;
  }, [runSummaries]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    setIsRoomDetailsOpen(window.localStorage.getItem('acpx-room-details-open') === 'true');
    const inspectorValue = window.localStorage.getItem('acpx-inspector-open');
    setIsInspectorOpen(inspectorValue !== 'false');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('acpx-room-details-open', String(isRoomDetailsOpen));
  }, [isRoomDetailsOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('acpx-inspector-open', String(isInspectorOpen));
  }, [isInspectorOpen]);


  const fetchTaskInfo = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      const data = await res.json();
      setTask(data);
    } catch (error) {
      console.error('Failed to fetch task:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTaskRoom = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/room`);
      const data = await res.json();
      setTaskRoom(data.room || null);
    } catch (error) {
      console.error('Failed to fetch task room:', error);
    }
  };

  const fetchRoomMessages = async (roomId: string) => {
    try {
      const res = await fetch(`/api/chat/messages?roomId=${encodeURIComponent(roomId)}&limit=100`);
      const data = await res.json();
      setRoomMessages(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch task room messages:', error);
    }
  };

  const fetchStandardLogs = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/logs`);
      const logData = await res.json();
      const newMessages: StandardLogMessage[] = [];

      if (logData.metadata?.createdAt) {
        newMessages.push({
          id: 'created',
          timestamp: logData.metadata.createdAt,
          sender: 'system',
          messageType: 'info',
          content: `任务 "${logData.taskName}" 已创建`,
        });
      }

      if (logData.executionLogs && logData.executionLogs.length > 0) {
        logData.executionLogs.forEach((log: StandardLogMessage, index: number) => {
          newMessages.push({
            id: `result-${index}`,
            timestamp: log.timestamp,
            sender: 'agent',
            senderName: log.senderName,
            messageType: log.messageType,
            content: log.content,
          });
        });
      }

      setStandardMessages(newMessages);
      setIsConnected(logData.status !== 'completed' && logData.status !== 'failed');
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    }
  };

  const fetchRuns = async (preferredRunId?: string | null) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/runs`);
      const data = await res.json();
      const runs = Array.isArray(data.runs) ? data.runs : [];
      setRunSummaries(runs);

      const nextRunId = preferredRunId && runs.some((run: TaskRunSummary) => run.id === preferredRunId)
        ? preferredRunId
        : selectedRunId && runs.some((run: TaskRunSummary) => run.id === selectedRunId)
        ? selectedRunId
        : runs[0]?.id || null;
      setSelectedRunId(nextRunId);

      if (nextRunId) {
        setIsConnected(runs.find((run: TaskRunSummary) => run.id === nextRunId)?.status === 'running');
      }
    } catch (error) {
      console.error('Failed to fetch task runs:', error);
    }
  };

  const fetchSelectedRun = async (runId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/runs/latest?runId=${encodeURIComponent(runId)}`);
      const data: SelectedRunResponse = await res.json();
      setSelectedRun(data.latestRun);
      if (data.latestRun) {
        setIsConnected(data.latestRun.status === 'running' || data.latestRun.status === 'pending');
      }
    } catch (error) {
      console.error('Failed to fetch selected task run:', error);
    }
  };


  return {
    taskId, task, setTask, taskRoom, setTaskRoom, roomMessages, setRoomMessages,
    messageInput, setMessageInput, messageTargetType, setMessageTargetType,
    messageTargetParticipantKey, setMessageTargetParticipantKey, standardMessages,
    setStandardMessages, runSummaries, setRunSummaries, selectedRunId, setSelectedRunId,
    selectedRun, setSelectedRun, isConnected, setIsConnected, socketUnavailableReason,
    setSocketUnavailableReason, isLoading, isExecuting, setIsExecuting, isSending,
    setIsSending, controlError, setControlError, composerNotice, setComposerNotice,
    participantProbeState, setParticipantProbeState, permissionConfig, setPermissionConfig,
    isPermissionEditorOpen, setIsPermissionEditorOpen, isSavingPermissionConfig,
    setIsSavingPermissionConfig, permissionConfigNotice, setPermissionConfigNotice,
    conversationMode, setConversationMode, isRoomDetailsOpen, setIsRoomDetailsOpen,
    isInspectorOpen, setIsInspectorOpen, isRunHistoryOpen, setIsRunHistoryOpen,
    isSelectedSummaryOpen, setIsSelectedSummaryOpen, isParticipantOutcomesOpen,
    setIsParticipantOutcomesOpen, timelineContainerRef, shouldAutoScrollRef, pollingRef,
    runSummariesRef, fetchTaskInfo, fetchTaskRoom, fetchRoomMessages, fetchStandardLogs,
    fetchRuns, fetchSelectedRun,
  };
};

export type TaskChatState = ReturnType<typeof useTaskChatState>;
