'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSocketClient, type ChatMessage } from '@/lib/websocket-client';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { DEFAULT_ACPX_PERMISSION_CONFIG, getPermissionProfileLabel } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';

interface AgentInfo {
  id: string;
  name: string;
  type: string;
  gateway?: {
    id: string;
    name: string;
  } | null;
}

interface AcpxParticipantSpec {
  gatewayId: string;
  gatewayName?: string;
  executionBackend: 'platform_local' | 'gateway_openclaw';
  harnessType: string;
  harnessLabel?: string;
  role: string;
  agentId?: string;
  agentName?: string;
}

interface TaskInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  executionMode?: 'standard' | 'acpx';
  workingDirectory?: string | null;
  acpxPermissionConfig?: AcpxPermissionConfig;
  currentTaskSession?: {
    id: string;
    status: string;
    attentionState: string;
    activeRunId?: string | null;
  } | null;
  assignedAgents: AgentInfo[];
  acpxParticipants?: AcpxParticipantSpec[];
}

interface TaskRoomInfo {
  id: string;
  name: string;
  description?: string | null;
}

interface TaskRoomMessageTargetOption {
  type: 'task' | 'participant' | 'all';
  participantKey?: string | null;
  participantLabel?: string | null;
  label: string;
}

type ComposerMode =
  | 'continue_session'
  | 'queue_only_busy'
  | 'queue_then_start_new_run';

interface ConversationFeedItem {
  id: string;
  createdAt: string;
  type: 'room_message' | 'run_event';
  roomMessage?: ChatMessage;
  runEvent?: TaskRunEvent;
}

interface StandardLogMessage {
  id: string;
  timestamp: string;
  sender: 'system' | 'agent';
  senderName?: string;
  messageType: 'info' | 'output' | 'error' | 'result';
  content: string;
}

interface TaskRunEvent {
  id: string;
  taskRunId: string;
  participantId?: string | null;
  participant?: {
    gatewayId?: string | null;
    gatewayName: string;
    executionBackend: 'platform_local' | 'gateway_openclaw';
    harnessType: string;
    harnessLabel?: string | null;
    role: string;
    agentId?: string | null;
    agentName?: string | null;
  } | null;
  sequence: number;
  eventType: string;
  stream: 'system' | 'stdout' | 'stderr';
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

interface TaskRunParticipant {
  id: string;
  gatewayId?: string | null;
  gatewayName: string;
  executionBackend: 'platform_local' | 'gateway_openclaw';
  harnessType: string;
  harnessLabel?: string | null;
  role: string;
  agentId?: string | null;
  agentName?: string | null;
  status: string;
  activityState?: string;
  summary?: string | null;
  error?: string | null;
  filesModified: string[];
  controlMetadata?: Record<string, unknown> | null;
  interruptSupported?: boolean;
  resumeSupported?: boolean;
  sessionControlSupported?: boolean;
  softStopSupported?: boolean;
}

interface TaskRunSummary {
  id: string;
  taskSessionId?: string | null;
  mode: string;
  orchestrationMode: string;
  status: string;
  controlState?: string;
  activityState?: string;
  summary?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  participants: Array<{
    id: string;
    gatewayId?: string | null;
    gatewayName: string;
    executionBackend: 'platform_local' | 'gateway_openclaw';
    harnessType: string;
    role: string;
    status: string;
  }>;
}

interface SelectedRunResponse {
  taskId: string;
  executionMode: 'standard' | 'acpx';
  latestRun: {
    id: string;
    taskSessionId?: string | null;
    orchestrationMode: string;
    status: string;
    controlState?: string;
    activityState?: string;
    controlMetadata?: Record<string, unknown> | null;
    summary?: string | null;
    error?: string | null;
    participants: TaskRunParticipant[];
    events: TaskRunEvent[];
  } | null;
}

const taskRoomUser = {
  id: 'task-room-user',
  name: '用户',
};

export default function TaskChatPage() {
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
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

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

      if (
        event.eventType === 'run_completed'
        || event.eventType === 'run_failed'
        || event.eventType === 'run_interrupted'
        || event.eventType === 'run_stopped'
        || event.eventType === 'control_message'
      ) {
        setIsExecuting(false);
        void fetchTaskInfo();
        void fetchRuns();
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

  const selectedRunEvents = useMemo(() => selectedRun?.events || [], [selectedRun]);
  const latestHarnessRequest = useMemo(() => {
    if (
      !selectedRun
      || selectedRun.status !== 'waiting_for_input'
    ) {
      return null;
    }

    for (let index = selectedRunEvents.length - 1; index >= 0; index -= 1) {
      const event = selectedRunEvents[index];
      const requestKind =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.requestKind === 'string'
          ? event.metadata.requestKind
          : null;
      const requestRunStatus =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.runStatus === 'string'
          ? event.metadata.runStatus
          : null;

      if (requestKind && requestRunStatus === 'waiting_for_input') {
        return {
          kind: requestKind,
          message: event.content,
          excerpt:
            event.metadata && typeof event.metadata.excerpt === 'string'
              ? event.metadata.excerpt
              : null,
        };
      }
    }

    return null;
  }, [selectedRun, selectedRunEvents]);

  const latestHarnessRequestIsActionable =
    latestHarnessRequest?.kind === 'permission_request'
    || latestHarnessRequest?.kind === 'input_request'
    || latestHarnessRequest?.kind === 'choice_request';

  const activeParticipant = useMemo(
    () =>
      selectedRun?.participants.find(
        (participant) => participant.status === 'running' || participant.status === 'waiting_for_input'
      ) || null,
    [selectedRun?.participants]
  );

  const activeParticipantLabel = activeParticipant
    ? `${activeParticipant.role} · ${
        activeParticipant.executionBackend === 'platform_local'
          ? 'Platform Local'
          : activeParticipant.gatewayName
      } / ${activeParticipant.harnessType}`
    : null;

  const continuationParticipant = useMemo(() => {
    if (!selectedRun || task?.status === 'running') {
      return null;
    }

    const participants = selectedRun.participants.filter((participant) => {
      const threadId = participant.controlMetadata?.codexThreadId ?? participant.controlMetadata?.lastSessionThreadId;
      return (
        participant.executionBackend === 'platform_local'
        && participant.harnessType === 'codex'
        && typeof threadId === 'string'
        && threadId.trim().length > 0
      );
    });

    if (participants.length === 0) {
      return null;
    }

    if (messageTargetType === 'participant') {
      return participants.find(
        (participant) =>
          getTaskRoomParticipantTargetKey({
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }) === messageTargetParticipantKey
      ) || null;
    }

    return participants[0] || null;
  }, [messageTargetParticipantKey, messageTargetType, selectedRun, task?.status]);

  const continuationParticipantLabel = continuationParticipant
    ? `${continuationParticipant.role} · ${
        continuationParticipant.executionBackend === 'platform_local'
          ? 'Platform Local'
          : continuationParticipant.gatewayName
      } / ${continuationParticipant.harnessType}`
    : null;

  const canContinueSelectedSession = !!continuationParticipant;
  const composerMode: ComposerMode = task?.executionMode === 'acpx'
    ? task.status === 'running'
      ? 'queue_only_busy'
      : canContinueSelectedSession
      ? 'continue_session'
      : 'queue_then_start_new_run'
    : 'queue_then_start_new_run';

  const conversationFeed = useMemo<ConversationFeedItem[]>(() => {
    const roomItems = roomMessages.map((message) => ({
      id: `room-${message.id}`,
      createdAt: message.createdAt,
      type: 'room_message' as const,
      roomMessage: message,
    }));
    const eventItems = selectedRunEvents.map((event) => ({
      id: `event-${event.id}`,
      createdAt: event.createdAt,
      type: 'run_event' as const,
      runEvent: event,
    }));

    return [...roomItems, ...eventItems].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  }, [roomMessages, selectedRunEvents]);

  const remoteQuietHint = useMemo(() => {
    if (
      !selectedRun
      || selectedRun.status !== 'running'
      || !activeParticipant
      || activeParticipant.executionBackend !== 'gateway_openclaw'
    ) {
      return null;
    }

    const lastEventTime = selectedRunEvents.length > 0
      ? new Date(selectedRunEvents[selectedRunEvents.length - 1].createdAt).getTime()
      : null;
    const quietMinutes = lastEventTime
      ? Math.max(0, Math.floor((Date.now() - lastEventTime) / 60000))
      : null;

    return quietMinutes && quietMinutes >= 1
      ? `当前是远端 ${activeParticipantLabel} 在运行，可能只会在完成后返回结果。已经安静 ${quietMinutes} 分钟，这不一定表示它已卡死。`
      : `当前是远端 ${activeParticipantLabel} 在运行，可能只会在完成后返回结果；没有流式输出不一定表示它已卡死。`;
  }, [activeParticipant, activeParticipantLabel, selectedRun, selectedRunEvents]);

  const selectedRunSessionTracking = useMemo(() => {
    const metadata = selectedRun?.controlMetadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const tracking = metadata.sessionTracking;
    return tracking && typeof tracking === 'object'
      ? tracking as Record<string, unknown>
      : null;
  }, [selectedRun?.controlMetadata]);

  const selectedRunSessionTrackingLabel = useMemo(() => {
    if (!selectedRunSessionTracking) {
      return null;
    }

    const sameSessionConfirmed = selectedRunSessionTracking.sameSessionConfirmed;
    const actualThreadId = typeof selectedRunSessionTracking.actualThreadId === 'string'
      ? selectedRunSessionTracking.actualThreadId
      : null;

    if (sameSessionConfirmed === true) {
      return actualThreadId
        ? `same Codex session confirmed · ${actualThreadId}`
        : 'same Codex session confirmed';
    }

    if (sameSessionConfirmed === false) {
      return 'Codex session mismatch detected';
    }

    return null;
  }, [selectedRunSessionTracking]);

  const selectedRunPermissionConfig = useMemo(() => {
    const metadata = selectedRun?.controlMetadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const config = metadata.permissionConfig;
    return config && typeof config === 'object'
      ? config as AcpxPermissionConfig
      : null;
  }, [selectedRun?.controlMetadata]);

  const primarySendLabel = task?.executionMode === 'acpx'
    ? composerMode === 'queue_only_busy'
      ? '排队到后续轮次'
      : composerMode === 'continue_session'
      ? '继续当前对话'
      : '发送并启动新一轮'
    : '发送到 Task Room';

  const composerBehaviorHint = task?.executionMode === 'acpx'
    ? composerMode === 'queue_only_busy'
      ? `当前 ${activeParticipantLabel || 'harness'} 正在执行当前 turn；现在还不能把新消息原地送进这次运行，主按钮只会先排队。`
      : composerMode === 'continue_session'
      ? `当前可以继续 ${continuationParticipantLabel || 'local Codex'} 的同一会话；主按钮会把消息送入同一个 Codex thread。`
      : `当前没有忙碌中的 harness；主按钮会先把消息写入 task room，再启动一轮新的运行。`
    : null;

  const taskRoomTargetOptions = useMemo<TaskRoomMessageTargetOption[]>(() => {
    const participantOptions = (task?.acpxParticipants || []).map((participant) => ({
      type: 'participant' as const,
      participantKey: getTaskRoomParticipantTargetKey(participant),
      participantLabel: getTaskRoomParticipantTargetLabel(participant),
      label: getTaskRoomParticipantTargetLabel(participant),
    }));

    return [
      { type: 'task', label: '整个任务' },
      ...participantOptions,
      { type: 'all', label: '全部参与方' },
    ];
  }, [task?.acpxParticipants]);

  const selectedTargetLabel = useMemo(() => {
    if (messageTargetType === 'all') {
      return '全部参与方';
    }

    if (messageTargetType === 'participant') {
      return (
        taskRoomTargetOptions.find(
          (option) => option.type === 'participant' && option.participantKey === messageTargetParticipantKey
        )?.participantLabel || '指定参与方'
      );
    }

    return '整个任务';
  }, [messageTargetParticipantKey, messageTargetType, taskRoomTargetOptions]);

  useEffect(() => {
    if (messageTargetType !== 'participant') {
      return;
    }

    if (
      taskRoomTargetOptions.some(
        (option) => option.type === 'participant' && option.participantKey === messageTargetParticipantKey
      )
    ) {
      return;
    }

    const firstParticipantOption = taskRoomTargetOptions.find((option) => option.type === 'participant');
    setMessageTargetParticipantKey(firstParticipantOption?.participantKey || '');
  }, [messageTargetParticipantKey, messageTargetType, taskRoomTargetOptions]);

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

  const fetchRuns = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/runs`);
      const data = await res.json();
      const runs = Array.isArray(data.runs) ? data.runs : [];
      setRunSummaries(runs);

      const nextRunId = selectedRunId && runs.some((run: TaskRunSummary) => run.id === selectedRunId)
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

  const handlePermissionProfileChange = (
    profile: AcpxPermissionConfig['profile']
  ) => {
    setPermissionConfigNotice(null);
    if (profile === 'safe_local') {
      setPermissionConfig({
        profile,
        sandboxMode: 'workspace-write',
        networkAccess: 'restricted',
        approvalPolicy: 'never',
        writableRoots: [],
      });
      return;
    }

    if (profile === 'dev_local') {
      setPermissionConfig({
        profile,
        sandboxMode: 'workspace-write',
        networkAccess: 'enabled',
        approvalPolicy: 'on-request',
        writableRoots: permissionConfig.writableRoots,
      });
      return;
    }

    if (profile === 'full_access') {
      setPermissionConfig({
        profile,
        sandboxMode: 'danger-full-access',
        networkAccess: 'enabled',
        approvalPolicy: 'on-request',
        writableRoots: permissionConfig.writableRoots,
      });
      return;
    }

    setPermissionConfig((prev) => ({
      ...prev,
      profile: 'custom',
    }));
  };

  const handlePermissionConfigSave = async () => {
    setIsSavingPermissionConfig(true);
    setPermissionConfigNotice(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          acpxPermissionConfig: permissionConfig,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '保存权限设置失败');
      }

      const updatedTask: TaskInfo = await res.json();
      setTask(updatedTask);
      setPermissionConfig(updatedTask.acpxPermissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG);
      setPermissionConfigNotice('权限设置已保存；新的 run / continuation 会使用这组配置。');
    } catch (error) {
      setPermissionConfigNotice(error instanceof Error ? error.message : '保存权限设置失败');
    } finally {
      setIsSavingPermissionConfig(false);
    }
  };

  const handleSendMessage = async () => {
    if (task?.executionMode === 'acpx') {
      await handleAcpxControl('queue_message', 'queued');
      return;
    }

    const content = messageInput.trim();
    if (!content || !taskRoom) {
      return;
    }

    setIsSending(true);
    shouldAutoScrollRef.current = true;
    try {
      const socket = getSocketClient();
      const optimisticMessage: ChatMessage = {
        id: `temp-${Date.now()}`,
        roomId: taskRoom.id,
        user: taskRoomUser,
        content,
        target: {
          type: 'task',
        },
        createdAt: new Date().toISOString(),
      };

      setRoomMessages((prev) => [...prev, optimisticMessage]);
      setMessageInput('');

      if (socket) {
        socket.emit('chat:message', {
          roomId: taskRoom.id,
          user: taskRoomUser,
          content,
          target: {
            type: 'task',
          },
          createdAt: optimisticMessage.createdAt,
        });
      }

      await fetchRoomMessages(taskRoom.id);
    } catch (error) {
      console.error('Failed to send task room message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleAcpxControl = async (
    action: 'queue_message' | 'interrupt_now' | 'stop_run' | 'continue_session',
    deliveryMode: 'queued' | 'immediate',
    overrideContent?: string
  ) => {
    if (!taskRoom || !task) {
      return;
    }

    const content = (overrideContent ?? messageInput).trim();
    if ((action === 'queue_message' || action === 'interrupt_now' || action === 'continue_session') && !content) {
      return;
    }

    setIsSending(true);
    setControlError(null);
    shouldAutoScrollRef.current = true;
    try {
      const taskWasRunning = task.status === 'running';
      const res = await fetch(`/api/tasks/${taskId}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          deliveryMode,
          content,
          runId: selectedRunId,
          targetType: messageTargetType,
          targetParticipantKey:
            messageTargetType === 'participant' ? messageTargetParticipantKey : null,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '发送控制请求失败');
      }

      const responseData = await res.json().catch(() => null);
      const deliveryResult =
        responseData?.delivery && typeof responseData.delivery.result === 'string'
          ? responseData.delivery.result
          : null;
      const fallbackReason =
        responseData?.delivery && typeof responseData.delivery.fallbackReason === 'string'
          ? responseData.delivery.fallbackReason
          : null;

      if (action === 'queue_message') {
        setComposerNotice(
          taskWasRunning
            ? `消息已发给${selectedTargetLabel}，当前 ${
                activeParticipantLabel || 'harness'
              } 忙碌中；这条消息已记入 task room，后续 handoff 或下一轮运行才会读取。`
            : `消息已发给${selectedTargetLabel}；当前没有忙碌中的 harness，平台会用这条消息启动一轮新的运行。`
        );
      } else if (action === 'continue_session') {
        setComposerNotice(
          deliveryResult === 'delivered_to_active_thread'
            ? `消息已发给${selectedTargetLabel}；平台正在继续 ${
                continuationParticipantLabel || '当前 local Codex'
              } 的同一会话。`
            : `消息已发给${selectedTargetLabel}；当前 continuation 未成功送达${fallbackReason ? `（${fallbackReason}）` : ''}。`
        );
      } else if (action === 'interrupt_now') {
        setComposerNotice(
          deliveryResult === 'delivered_control_signal'
            ? '已请求打断当前本地运行；平台会在后续重启时把这条消息带入下一轮。'
            : '中断请求已记录，但当前没有可直接接管的本地进程；后续需要手动重跑或等待下一阶段处理。'
        );
      } else {
        setComposerNotice(
          deliveryResult === 'delivered_control_signal'
            ? '已请求停止当前运行。'
            : '停止请求已记录，但当前没有可直接接管的本地进程。'
        );
      }

      if (!overrideContent) {
        setMessageInput('');
      }
      await fetchRoomMessages(taskRoom.id);
      await fetchRuns();
      const nextRunId =
        typeof responseData?.continuationRunId === 'string' && responseData.continuationRunId
          ? responseData.continuationRunId
          : selectedRunId;
      if (nextRunId) {
        setSelectedRunId(nextRunId);
        await fetchSelectedRun(nextRunId);
      }
      await fetchTaskInfo();

      if (action === 'queue_message' && !taskWasRunning) {
        await handleExecuteTask();
      }
    } catch (error) {
      console.error('Failed to send ACPX control message:', error);
      setControlError(error instanceof Error ? error.message : '发送控制请求失败');
    } finally {
      setIsSending(false);
    }
  };

  const waitForTaskToLeaveRunningState = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await fetch(`/api/tasks/${taskId}`);
      const data = await res.json();
      if (data.status !== 'running') {
        setTask(data);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return false;
  };

  const handleHarnessDecision = async (decision: 'allow' | 'deny' | 'explain') => {
    const content =
      decision === 'allow'
        ? '我同意你继续刚才请求的权限或操作。请在下一轮开始时继续，并先简短说明你将执行什么。'
        : decision === 'deny'
        ? '我不同意刚才请求的权限或操作。请在下一轮改用不需要该权限的方案，并说明替代路径。'
        : '请在下一轮先明确说明你刚才需要我确认的具体权限、原因、影响范围，以及你希望我确认什么。';

    await handleAcpxControl('interrupt_now', 'immediate', content);

    if (decision !== 'explain') {
      const readyToRestart = await waitForTaskToLeaveRunningState();
      if (readyToRestart) {
        await handleExecuteTask();
      }
    }
  };

  const handlePrimaryAcpxSend = async () => {
    if (composerMode === 'continue_session') {
      await handleAcpxControl('continue_session', 'immediate');
      return;
    }

    await handleAcpxControl('queue_message', 'queued');
  };

  const handleTimelineScroll = () => {
    const container = timelineContainerRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 80;
  };

  const handleParticipantConnectivityProbe = async (participant: TaskRunParticipant) => {
    if (participant.executionBackend !== 'gateway_openclaw' || !participant.gatewayId) {
      return;
    }

    setParticipantProbeState((prev) => ({
      ...prev,
      [participant.id]: {
        status: 'testing',
        message: '正在测试远端连接…',
      },
    }));

    try {
      const response = await fetch(`/api/gateways/${participant.gatewayId}/openclaw/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: 'Reply with exactly: ACPX connectivity OK',
          agentId: participant.agentId || undefined,
          sessionKey: `task-${taskId}-probe`,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '远端 OpenClaw 连通性测试失败');
      }

      setParticipantProbeState((prev) => ({
        ...prev,
        [participant.id]: {
          status: 'success',
          message: typeof data?.text === 'string' && data.text.trim()
            ? data.text.trim()
            : '远端已返回响应。',
        },
      }));
    } catch (error) {
      setParticipantProbeState((prev) => ({
        ...prev,
        [participant.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : '远端连接测试失败',
        },
      }));
    }
  };

  const handleExecuteTask = async () => {
    setIsExecuting(true);
    try {
      setTask((prev) => (prev ? { ...prev, status: 'running' } : prev));
      const res = await fetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST',
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '执行任务失败');
      }
      await fetchTaskInfo();
      await fetchRuns();
    } catch (error) {
      console.error('Failed to execute task:', error);
      await fetchTaskInfo();
    } finally {
      setIsExecuting(false);
    }
  };

  const canExecute = task && task.status !== 'running';
  const selectedRunCanInterrupt =
    selectedRun?.status === 'running' || selectedRun?.status === 'waiting_for_input'
      ? selectedRun.participants.some((participant) => participant.interruptSupported)
      : false;
  const selectedRunCanStop =
    selectedRun?.status === 'running' || selectedRun?.status === 'waiting_for_input'
      ? selectedRun.participants.some((participant) => participant.softStopSupported || participant.interruptSupported)
      : false;

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!task) {
    return <div className="p-8 text-gray-600">任务不存在</div>;
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-[1600px] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-[#f7f7f8] shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <header className="shrink-0 border-b border-slate-200/80 bg-white/92 px-4 py-3 backdrop-blur xl:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
              <span>{task.executionMode === 'acpx' ? 'ACPX Task Room' : 'Task Chat'}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{taskRoom?.name || 'Task Room'}</span>
            </div>
            <h1 className="mt-1 truncate text-lg font-semibold text-slate-900 xl:text-xl">{task.name}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-[11px] font-medium ${
              isConnected
                ? 'bg-emerald-100 text-emerald-800'
                : socketUnavailableReason
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600'
            }`}>
              {isConnected ? '实时连接中' : socketUnavailableReason ? '轮询刷新中' : '等待刷新'}
            </span>
            {selectedRun?.status ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-700">
                run {selectedRun.status}
              </span>
            ) : null}
            {selectedRun?.activityState ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-700">
                activity {selectedRun.activityState}
              </span>
            ) : null}
            {canExecute ? (
              <button
                onClick={() => void handleExecuteTask()}
                disabled={isExecuting}
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isExecuting ? '执行中...' : '开始运行'}
              </button>
            ) : (
              <span className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-700">
                当前任务运行中
              </span>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          {task.executionMode === 'acpx' ? (
            <span className="rounded-full border border-slate-200 bg-slate-50/70 px-2.5 py-1">
              聊天优先布局已启用
            </span>
          ) : null}
          {task.executionMode === 'acpx' ? (
            <>
              <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                Profile: {getPermissionProfileLabel(permissionConfig.profile)}
              </span>
              <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                Sandbox: {permissionConfig.sandboxMode}
              </span>
              <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                Network: {permissionConfig.networkAccess}
              </span>
              <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                Approval: {permissionConfig.approvalPolicy}
              </span>
            </>
          ) : null}
          {task.executionMode === 'acpx' && task.acpxParticipants?.length
            ? task.acpxParticipants.map((participant, index) => (
                <span
                  key={`${participant.gatewayId}-${participant.harnessType}-${index}`}
                  className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500"
                >
                  {participant.role} · {participant.executionBackend === 'platform_local' ? 'Local' : (participant.gatewayName || participant.gatewayId)} / {participant.harnessType}
                </span>
              ))
            : null}
          {socketUnavailableReason ? (
            <span className="rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-amber-700">
              socket unavailable: {socketUnavailableReason}
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 overflow-hidden xl:grid-cols-[minmax(0,1fr),300px]">
        <section className="grid min-h-0 grid-rows-[auto,minmax(0,1fr),auto] overflow-hidden bg-[#f7f7f8]">
          <div className="shrink-0 border-b border-slate-200/70 bg-[#f7f7f8] px-4 py-3 xl:px-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">对话</span>
              {selectedRun?.controlState ? (
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                  control {selectedRun.controlState}
                </span>
              ) : null}
              {selectedRunPermissionConfig ? (
                <>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                    run sandbox {selectedRunPermissionConfig.sandboxMode}
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                    run network {selectedRunPermissionConfig.networkAccess}
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                    run approval {selectedRunPermissionConfig.approvalPolicy}
                  </span>
                </>
              ) : null}
              {selectedRunSessionTrackingLabel ? (
                <span className={`rounded-full px-2.5 py-1 text-[11px] shadow-sm ring-1 ${
                  selectedRunSessionTracking?.sameSessionConfirmed === false
                    ? 'bg-rose-50 text-rose-700 ring-rose-200'
                    : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                }`}>
                  {selectedRunSessionTrackingLabel}
                </span>
              ) : null}
              {composerBehaviorHint ? (
                <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] text-sky-700 ring-1 ring-sky-200">
                  {composerBehaviorHint}
                </span>
              ) : null}
              {remoteQuietHint ? (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                  {remoteQuietHint}
                </span>
              ) : null}
              {selectedRun?.status === 'waiting_for_input' ? (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                  当前在等待用户输入或平台下一步处理
                </span>
              ) : null}
            </div>

            {latestHarnessRequest ? (
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/85 p-3 text-xs text-amber-950 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">最近一次 harness 请求: {latestHarnessRequest.kind}</div>
                  {!latestHarnessRequestIsActionable ? (
                    <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      仅提示，不是可批准请求
                    </span>
                  ) : (
                    <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      按钮会生成后续处理消息，不会原地注入当前 session
                    </span>
                  )}
                </div>
                <div className="mt-2 whitespace-pre-wrap leading-5">{latestHarnessRequest.message}</div>
                {latestHarnessRequest.excerpt ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-white/80 p-3 text-[11px] text-amber-900">
                    {latestHarnessRequest.excerpt}
                  </pre>
                ) : null}
                {latestHarnessRequestIsActionable ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void handleHarnessDecision('allow')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-full bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
                    >
                      同意并转入下一轮
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('deny')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-full bg-rose-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
                    >
                      拒绝并转入下一轮
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('explain')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-full bg-slate-800 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-900 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      先补充说明
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {task.executionMode === 'acpx' ? (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 p-3 text-xs text-slate-700 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-slate-800">Local Codex 权限设置</div>
                  <button
                    onClick={() => setIsPermissionEditorOpen((prev) => !prev)}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    {isPermissionEditorOpen ? '收起权限设置' : '打开权限设置'}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">
                    {getPermissionProfileLabel(permissionConfig.profile)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">
                    Sandbox: {permissionConfig.sandboxMode}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">
                    Network: {permissionConfig.networkAccess}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1">
                    Approval: {permissionConfig.approvalPolicy}
                  </span>
                  {permissionConfig.writableRoots.length > 0 ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1">
                      writable roots: {permissionConfig.writableRoots.length}
                    </span>
                  ) : null}
                </div>

                {isPermissionEditorOpen ? (
                  <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
                    <div className="flex flex-wrap gap-2">
                      {(['safe_local', 'dev_local', 'full_access'] as const).map((profile) => (
                        <button
                          key={profile}
                          onClick={() => handlePermissionProfileChange(profile)}
                          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                            permissionConfig.profile === profile
                              ? 'bg-slate-900 text-white'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {getPermissionProfileLabel(profile)}
                        </button>
                      ))}
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Sandbox</div>
                        <select
                          value={permissionConfig.sandboxMode}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              sandboxMode: event.target.value as AcpxPermissionConfig['sandboxMode'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="read-only">read-only</option>
                          <option value="workspace-write">workspace-write</option>
                          <option value="danger-full-access">danger-full-access</option>
                        </select>
                      </label>

                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Network</div>
                        <select
                          value={permissionConfig.networkAccess}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              networkAccess: event.target.value as AcpxPermissionConfig['networkAccess'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="restricted">restricted</option>
                          <option value="enabled">enabled</option>
                        </select>
                      </label>

                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Approval</div>
                        <select
                          value={permissionConfig.approvalPolicy}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              approvalPolicy: event.target.value as AcpxPermissionConfig['approvalPolicy'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="never">never</option>
                          <option value="on-request">on-request</option>
                        </select>
                      </label>
                    </div>

                    <label className="block space-y-1">
                      <div className="text-[11px] font-medium text-slate-600">Writable Roots</div>
                      <textarea
                        value={permissionConfig.writableRoots.join('\n')}
                        onChange={(event) =>
                          setPermissionConfig((prev) => ({
                            ...prev,
                            profile: 'custom',
                            writableRoots: event.target.value
                              .split('\n')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          }))
                        }
                        rows={3}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        placeholder={"/data1/ai-services/deepseek_ocr\n/data/cache/modelscope\n/tmp"}
                      />
                    </label>

                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                      当前第一版会真实应用到 local Codex CLI 的主要是 sandbox 和 approval。network / writable roots 会被保存并显示在 run metadata 中，便于后续继续接权限能力。
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {permissionConfigNotice ? (
                        <div className="text-[11px] text-slate-600">{permissionConfigNotice}</div>
                      ) : (
                        <div className="text-[11px] text-slate-500">
                          新设置会影响下一次新 run 或 continuation，不会热切换当前正在执行的 turn。
                        </div>
                      )}
                      <button
                        onClick={() => void handlePermissionConfigSave()}
                        disabled={isSavingPermissionConfig}
                        className="rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isSavingPermissionConfig ? '保存中...' : '保存权限设置'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div
            ref={timelineContainerRef}
            onScroll={handleTimelineScroll}
            className="min-h-0 overflow-y-auto px-3 py-4 xl:px-6"
          >
            {task.executionMode !== 'acpx' ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
                {standardMessages.map((message) => (
                  <div key={message.id} className="rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                    <div className="mb-1 text-xs text-slate-500">
                      {new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}
                      {message.senderName ? ` · ${message.senderName}` : ''}
                    </div>
                    <div className={message.messageType === 'error' ? 'text-red-600' : 'text-slate-900'}>
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>
            ) : conversationFeed.length === 0 ? (
              <div className="mx-auto max-w-3xl rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-8 text-sm text-slate-500 shadow-sm">
                还没有消息或运行事件。你可以先发一条消息，然后平台会在这里持续展示对话和运行过程。
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
                {conversationFeed.map((item) => {
                  if (item.type === 'room_message' && item.roomMessage) {
                    const message = item.roomMessage;
                    const isOwn = message.user.id === taskRoomUser.id;
                    const bubbleClass = isOwn
                      ? 'ml-auto bg-[#111827] text-white'
                      : message.user.id === 'system'
                      ? 'bg-slate-200 text-slate-900'
                      : 'bg-white text-slate-900 ring-1 ring-slate-200';

                    return (
                      <div key={item.id} className={`max-w-[85%] rounded-[28px] px-5 py-4 shadow-sm ${bubbleClass}`}>
                        <div className={`mb-1 text-xs ${isOwn ? 'text-slate-300' : 'text-slate-500'}`}>
                          {message.user.name} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </div>
                        {message.target.type !== 'task' ? (
                          <div className={`mb-2 text-[11px] ${isOwn ? 'text-slate-300' : 'text-slate-500'}`}>
                            {message.target.type === 'all'
                              ? '发给：全部参与方'
                              : `发给：${message.target.participantLabel || '指定参与方'}`}
                          </div>
                        ) : null}
                        <div className="whitespace-pre-wrap break-words">{message.content}</div>
                      </div>
                    );
                  }

                  if (!item.runEvent) {
                    return null;
                  }

                  const event = item.runEvent;
                  const isAssistantReply =
                    event.eventType === 'stdout_chunk'
                    && event.stream === 'stdout'
                    && !!event.participant
                    && event.participant.executionBackend === 'platform_local';
                  const isSystemEvent =
                    event.eventType === 'session_continuation_started'
                    || event.eventType === 'control_message';
                  const isLiveSummaryDuplicate =
                    event.eventType === 'summary'
                    && event.metadata
                    && event.metadata.streamingMode === 'live';

                  if (isLiveSummaryDuplicate) {
                    return null;
                  }

                  if (event.eventType === 'session_continuation_started') {
                    return (
                      <div key={item.id} className="mx-auto max-w-2xl">
                        <div className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-center text-xs text-sky-800 shadow-sm">
                          {event.content}
                        </div>
                      </div>
                    );
                  }

                  if (isAssistantReply) {
                    return (
                      <div key={item.id} className="max-w-[88%] rounded-[28px] bg-white px-5 py-4 text-slate-900 shadow-sm ring-1 ring-slate-200">
                        <div className="mb-1 text-xs text-slate-500">
                          {event.participant?.role || 'assistant'} · {new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </div>
                        <div className="whitespace-pre-wrap break-words">{event.content}</div>
                      </div>
                    );
                  }

                  const eventToneClass =
                    isSystemEvent
                      ? 'border-amber-200 bg-amber-50/80'
                      : 'border-slate-200/80 bg-white/88';
                  const deliveryResult =
                    event.eventType === 'control_message'
                    && event.metadata
                    && typeof event.metadata.deliveryResult === 'string'
                      ? event.metadata.deliveryResult
                      : null;

                  return (
                    <div
                      key={item.id}
                      className={`rounded-[22px] border px-4 py-3.5 shadow-sm ${eventToneClass}`}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        <span>{new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{event.eventType}</span>
                        {event.participant ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                            {event.participant.role} · {event.participant.executionBackend === 'platform_local' ? 'Platform Local' : event.participant.gatewayName} / {event.participant.harnessType}
                          </span>
                        ) : null}
                      </div>
                      {event.eventType === 'control_message' && event.metadata?.requestKind ? (
                        <div className="mb-2 text-[11px] text-amber-700">
                          request: {String(event.metadata.requestKind)}
                        </div>
                      ) : null}
                      {event.eventType === 'control_message' && deliveryResult ? (
                        <div className="mb-2 text-[11px] text-amber-700">
                          delivery: {deliveryResult}
                        </div>
                      ) : null}
                      <pre className={`whitespace-pre-wrap break-words font-mono text-xs ${event.stream === 'stderr' ? 'text-red-600' : 'text-slate-900'}`}>
                        {event.content}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="z-10 border-t border-slate-200 bg-white/95 px-3 py-3 backdrop-blur xl:px-6">
            {task.executionMode === 'acpx' ? (
              <div className="mx-auto max-w-4xl space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={messageTargetType}
                    onChange={(event) => setMessageTargetType(event.target.value as 'task' | 'participant' | 'all')}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 focus:border-transparent focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="task">发给整个任务</option>
                    <option value="participant">发给单个参与方</option>
                    <option value="all">发给全部参与方</option>
                  </select>
                  {messageTargetType === 'participant' ? (
                    <select
                      value={messageTargetParticipantKey}
                      onChange={(event) => setMessageTargetParticipantKey(event.target.value)}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 focus:border-transparent focus:ring-2 focus:ring-slate-400"
                    >
                      {taskRoomTargetOptions
                        .filter((option) => option.type === 'participant')
                        .map((option) => (
                          <option key={option.participantKey} value={option.participantKey || ''}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="rounded-full border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500">
                      当前目标：{selectedTargetLabel}
                    </div>
                  )}
                </div>

                <div className="rounded-[24px] border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_30px_rgba(15,23,42,0.06)]">
                  <textarea
                    value={messageInput}
                    onChange={(event) => setMessageInput(event.target.value)}
                    rows={2}
                    className="w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-0"
                    placeholder={
                      composerMode === 'queue_only_busy'
                        ? '输入要排队给后续轮次的要求、纠偏或补充信息……'
                        : composerMode === 'continue_session'
                        ? '输入要继续发送到同一个 Codex 会话的消息……'
                        : '输入要发送到 task room 并启动新一轮运行的消息……'
                    }
                  />
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] leading-5 text-slate-500">
                      {composerMode === 'queue_only_busy'
                        ? '当前这次 Codex turn 还没结束；新消息暂时不能原地注入，只能先排队到后续轮次。'
                        : composerMode === 'continue_session'
                        ? '主按钮会继续当前 Codex 会话；如果续接失败，再考虑改走排队或重开新一轮。'
                        : '主按钮会把消息写入 task room，并启动一轮新的运行。'}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleAcpxControl('interrupt_now', 'immediate')}
                        disabled={
                          isSending
                          || !taskRoom
                          || !messageInput.trim()
                          || !selectedRunCanInterrupt
                          || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                        }
                        className="rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-amber-200 disabled:text-amber-400"
                      >
                        打断并转入下一轮
                      </button>
                      <button
                        onClick={() => void handleAcpxControl('stop_run', 'immediate')}
                        disabled={isSending || !taskRoom || !selectedRunCanStop}
                        className="rounded-full border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-800 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-rose-200 disabled:text-rose-400"
                      >
                        停止运行
                      </button>
                      <button
                        onClick={() => void handlePrimaryAcpxSend()}
                        disabled={
                          isSending
                          || !taskRoom
                          || !messageInput.trim()
                          || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                        }
                        className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isSending ? '发送中...' : primarySendLabel}
                      </button>
                    </div>
                  </div>
                </div>

                {controlError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
                    {controlError}
                  </div>
                ) : null}
                {composerNotice ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
                    {composerNotice}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mx-auto max-w-4xl space-y-3">
                <div className="rounded-[24px] border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_30px_rgba(15,23,42,0.06)]">
                  <textarea
                    value={messageInput}
                    onChange={(event) => setMessageInput(event.target.value)}
                    rows={2}
                    className="w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-0"
                    placeholder="输入消息……"
                  />
                  <div className="mt-2.5 flex justify-end">
                    <button
                      onClick={() => void handleSendMessage()}
                      disabled={isSending || !taskRoom || !messageInput.trim()}
                      className="rounded-full bg-slate-900 px-5 py-2.5 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      {isSending ? '发送中...' : primarySendLabel}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="hidden min-h-0 border-l border-slate-200/80 bg-white/75 xl:flex xl:flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-900">Run History</div>
              <div className="mt-3 max-h-[30vh] space-y-2 overflow-y-auto pr-1">
                {runSummaries.length === 0 ? (
                  <div className="text-sm text-slate-500">还没有运行历史。</div>
                ) : (
                  runSummaries.map((run, index) => (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                        selectedRunId === run.id
                          ? 'border-slate-300 bg-slate-100'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900">Run {runSummaries.length - index}</div>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${
                          run.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : run.status === 'interrupted'
                            ? 'bg-amber-100 text-amber-800'
                            : run.status === 'stopped'
                            ? 'bg-orange-100 text-orange-800'
                            : run.status === 'failed'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {run.status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </div>
                      {run.activityState || run.controlState ? (
                        <div className="mt-1 text-[11px] text-slate-500">
                          {run.activityState ? `activity=${run.activityState}` : ''}
                          {run.activityState && run.controlState ? ' · ' : ''}
                          {run.controlState ? `control=${run.controlState}` : ''}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {run.participants.map((participant) => (
                          <span
                            key={participant.id}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                          >
                            {participant.role} / {participant.harnessType}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-900">Selected Run Summary</div>
              <div className="mt-3 whitespace-pre-wrap text-sm text-slate-600">
                {selectedRun?.summary || selectedRun?.error || '暂无运行摘要'}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-900">Participant Outcomes</div>
              <div className="mt-3 space-y-3">
                {(selectedRun?.participants || []).map((participant) => (
                  <div key={participant.id} className="rounded-2xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : participant.gatewayName} / {participant.harnessType}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        participant.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : participant.status === 'interrupted'
                          ? 'bg-amber-100 text-amber-800'
                          : participant.status === 'stopped'
                          ? 'bg-orange-100 text-orange-800'
                          : participant.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {participant.status}
                      </span>
                    </div>
                    {participant.activityState ? (
                      <div className="mt-2 text-xs text-slate-500">
                        activity: {participant.activityState}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-500">
                      {participant.interruptSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可中断</span> : null}
                      {participant.softStopSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可停止</span> : null}
                      {participant.resumeSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可恢复重启</span> : null}
                    </div>
                    {participant.executionBackend === 'gateway_openclaw' ? (
                      <div className="mt-3 space-y-2">
                        <button
                          onClick={() => void handleParticipantConnectivityProbe(participant)}
                          disabled={participantProbeState[participant.id]?.status === 'testing'}
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          {participantProbeState[participant.id]?.status === 'testing'
                            ? '测试中...'
                            : '测试远端连通性'}
                        </button>
                        {participantProbeState[participant.id]?.message ? (
                          <div className={`rounded-lg px-3 py-2 text-xs ${
                            participantProbeState[participant.id]?.status === 'error'
                              ? 'border border-red-200 bg-red-50 text-red-700'
                              : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                          }`}>
                            {participantProbeState[participant.id]?.message}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-3 text-xs text-slate-500">
                        本地 direct harness 的独立连通性测试还未做成单独入口。
                      </div>
                    )}
                    {participant.summary ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{participant.summary}</p>
                    ) : null}
                    {participant.error ? (
                      <p className="mt-2 text-sm text-red-600">{participant.error}</p>
                    ) : null}
                    {participant.filesModified.length > 0 ? (
                      <div className="mt-2 text-xs text-slate-500">
                        修改文件: {participant.filesModified.join(', ')}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
