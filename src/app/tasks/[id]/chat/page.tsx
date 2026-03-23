'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSocketClient, type ChatMessage } from '@/lib/websocket-client';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';

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

  const primarySendLabel = task?.executionMode === 'acpx'
    ? task.status === 'running'
      ? '发送消息'
      : '发送并开始运行'
    : '发送到 Task Room';

  const composerBehaviorHint = task?.executionMode === 'acpx'
    ? task.status === 'running'
      ? `当前 ${activeParticipantLabel || 'harness'} 正在处理任务，发送后会先进入队列，等待它到达下一个可处理节点。`
      : `当前没有忙碌中的 harness，发送后会把消息写入 task room，并立即触发新一轮运行。`
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
    action: 'queue_message' | 'interrupt_now' | 'stop_run',
    deliveryMode: 'queued' | 'immediate',
    overrideContent?: string
  ) => {
    if (!taskRoom || !task) {
      return;
    }

    const content = (overrideContent ?? messageInput).trim();
    if ((action === 'queue_message' || action === 'interrupt_now') && !content) {
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

      await res.json().catch(() => null);

      if (action === 'queue_message') {
        setComposerNotice(
          taskWasRunning
            ? `消息已发给${selectedTargetLabel}，当前 ${
                activeParticipantLabel || 'harness'
              } 忙碌中，平台会先排队，等待下一次可处理节点。`
            : `消息已发给${selectedTargetLabel}，当前没有忙碌中的 harness，平台会立即用这条消息启动下一轮运行。`
        );
      } else if (action === 'interrupt_now') {
        setComposerNotice('已请求打断当前本地运行，并带上这条消息进入下一轮处理。');
      } else {
        setComposerNotice('已请求停止当前运行。');
      }

      if (!overrideContent) {
        setMessageInput('');
      }
      await fetchRoomMessages(taskRoom.id);
      await fetchRuns();
      if (selectedRunId) {
        await fetchSelectedRun(selectedRunId);
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
        ? '我允许你继续执行刚才请求的权限或操作。请继续，并在继续前简短说明你将执行什么。'
        : decision === 'deny'
        ? '我不允许刚才请求的权限或操作。请停止该动作，改用不需要该权限的方案，并说明替代路径。'
        : '请明确说明你刚才需要我确认的具体权限、原因、影响范围，以及继续前你希望我点击或确认什么。';

    await handleAcpxControl('interrupt_now', 'immediate', content);

    if (decision !== 'explain') {
      const readyToRestart = await waitForTaskToLeaveRunningState();
      if (readyToRestart) {
        await handleExecuteTask();
      }
    }
  };

  const handlePrimaryAcpxSend = async () => {
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
  const selectedRunCanInterrupt = selectedRun?.status === 'running'
    || selectedRun?.status === 'waiting_for_input'
    ? selectedRun.participants.some((participant) => participant.interruptSupported)
    : false;
  const selectedRunCanStop = selectedRun?.status === 'running'
    || selectedRun?.status === 'waiting_for_input'
    ? selectedRun.participants.some((participant) => participant.softStopSupported || participant.interruptSupported)
    : false;

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!task) {
    return <div className="p-8 text-gray-600">任务不存在</div>;
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-7xl flex-col gap-3 overflow-hidden p-4">
      <div className="shrink-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{task.name}</h1>
            <p className="mt-2 text-sm text-gray-600">
              {task.executionMode === 'acpx' ? 'ACPX Task Room' : '任务执行日志'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className={`rounded-full px-3 py-1 text-xs ${
              isConnected
                ? 'bg-green-100 text-green-800'
                : socketUnavailableReason
                ? 'bg-amber-100 text-amber-800'
                : 'bg-gray-100 text-gray-700'
            }`}>
              {isConnected ? '实时连接中' : socketUnavailableReason ? '轮询刷新中' : '等待刷新'}
            </div>
            {canExecute ? (
              <button
                onClick={() => void handleExecuteTask()}
                disabled={isExecuting}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              >
                {isExecuting ? '执行中...' : '开始运行'}
              </button>
            ) : (
              <span className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                当前任务运行中
              </span>
            )}
          </div>
        </div>

        {task.executionMode === 'acpx' && task.acpxParticipants?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {task.acpxParticipants.map((participant, index) => (
              <span
                key={`${participant.gatewayId}-${participant.harnessType}-${index}`}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs text-indigo-700"
              >
                {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : (participant.gatewayName || participant.gatewayId)} / {participant.harnessType}
              </span>
            ))}
          </div>
        ) : null}

        {task.executionMode === 'acpx' || socketUnavailableReason ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-5 text-amber-800">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {task.executionMode === 'acpx' ? (
                <span>
                  Task room 已启用。主按钮会按聊天习惯工作；本地中断/停止仍属于第一版控制能力。
                </span>
              ) : null}
              {socketUnavailableReason ? (
                <span>
                  实时 socket 不可用：{socketUnavailableReason}，已自动切到轮询刷新。
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 max-h-full flex-1 gap-3 overflow-hidden xl:grid-cols-[minmax(0,1.85fr),360px]">
        <div className="grid min-h-0 h-full grid-rows-[auto,minmax(0,1fr),auto] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="max-h-[18vh] overflow-y-auto border-b border-gray-200 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-900">Task Conversation</div>
                <div className="mt-1 text-xs text-gray-500">
                  {taskRoom?.name || 'Task Room'}
                </div>
              </div>
              {selectedRun ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                    {selectedRun.status}
                  </span>
                  {selectedRun.activityState ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                      activity: {selectedRun.activityState}
                    </span>
                  ) : null}
                  {selectedRun.controlState ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                      control: {selectedRun.controlState}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {composerBehaviorHint || remoteQuietHint || selectedRun?.status === 'waiting_for_input' ? (
              <div className="mt-3 space-y-2 text-xs">
                {composerBehaviorHint ? (
                  <div className="rounded-md bg-blue-50 px-3 py-1.5 leading-5 text-blue-700">
                    {composerBehaviorHint}
                  </div>
                ) : null}
                {remoteQuietHint ? (
                  <div className="rounded-md bg-amber-50 px-3 py-1.5 leading-5 text-amber-800">
                    {remoteQuietHint}
                  </div>
                ) : null}
                {selectedRun?.status === 'waiting_for_input' ? (
                  <div className="rounded-md bg-amber-50 px-3 py-1.5 leading-5 text-amber-800">
                    当前 harness 正在等待用户输入或权限确认。下面的请求卡片仍是第一版过渡交互。
                  </div>
                ) : null}
              </div>
            ) : null}
            {latestHarnessRequest ? (
              <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <div className="font-semibold">
                  最近一次 harness 请求: {latestHarnessRequest.kind}
                </div>
                <div className="mt-2 whitespace-pre-wrap">
                  {latestHarnessRequest.message}
                </div>
                {latestHarnessRequest.excerpt ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-white/70 p-2 text-[11px] text-amber-900">
                    {latestHarnessRequest.excerpt}
                  </pre>
                ) : null}
                {latestHarnessRequestIsActionable ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    <button
                      onClick={() => void handleHarnessDecision('allow')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-green-300"
                    >
                      允许继续
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('deny')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
                    >
                      拒绝这次请求
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('explain')}
                      disabled={isSending || !selectedRunCanInterrupt}
                      className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      先解释清楚
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-white/70 px-3 py-2 text-[11px] text-amber-900">
                    这是一个运行问题提示，不是可直接点击批准的权限请求。
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div
            ref={timelineContainerRef}
            onScroll={handleTimelineScroll}
            className="min-h-0 overflow-y-auto bg-slate-50 px-4 py-3"
          >
            {task.executionMode !== 'acpx' ? (
              <div className="space-y-3">
                {standardMessages.map((message) => (
                  <div key={message.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
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
              <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
                还没有消息或运行事件。你可以先发一条消息，然后平台会在这里持续展示对话和运行过程。
              </div>
            ) : (
              <div className="space-y-3">
                {conversationFeed.map((item) => {
                  if (item.type === 'room_message' && item.roomMessage) {
                    const message = item.roomMessage;
                    const isOwn = message.user.id === taskRoomUser.id;
                    const bubbleClass = isOwn
                      ? 'ml-auto bg-blue-600 text-white'
                      : message.user.id === 'system'
                      ? 'bg-slate-200 text-slate-900'
                      : 'bg-emerald-100 text-emerald-950';

                    return (
                      <div key={item.id} className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${bubbleClass}`}>
                        <div className={`mb-1 text-xs ${isOwn ? 'text-blue-100' : 'text-slate-500'}`}>
                          {message.user.name} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </div>
                        {message.target.type !== 'task' ? (
                          <div className={`mb-2 text-[11px] ${isOwn ? 'text-blue-100' : 'text-slate-500'}`}>
                            {message.target.type === 'all'
                              ? '发给：全部参与方'
                              : `发给：${message.target.participantLabel || '指定参与方'}`}
                          </div>
                        ) : null}
                        <div className="whitespace-pre-wrap break-words">{message.content}</div>
                      </div>
                    );
                  }

                  if (item.runEvent) {
                    const event = item.runEvent;
                    return (
                      <div
                        key={item.id}
                        className={`rounded-2xl border px-4 py-3 shadow-sm ${
                          event.eventType === 'control_message'
                            ? 'border-amber-200 bg-amber-50'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          <span>{new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5">{event.eventType}</span>
                          {event.participant ? (
                            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700">
                              {event.participant.role} · {event.participant.executionBackend === 'platform_local' ? 'Platform Local' : event.participant.gatewayName} / {event.participant.harnessType}
                            </span>
                          ) : null}
                        </div>
                        {event.eventType === 'control_message' && event.metadata?.requestKind ? (
                          <div className="mb-2 text-[11px] text-amber-700">
                            request: {String(event.metadata.requestKind)}
                          </div>
                        ) : null}
                        <pre className={`whitespace-pre-wrap break-words font-mono text-xs ${event.stream === 'stderr' ? 'text-red-600' : 'text-slate-900'}`}>
                          {event.content}
                        </pre>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            )}
          </div>

          <div className="z-10 border-t border-gray-200 bg-white/95 p-3 backdrop-blur">
            {task.executionMode === 'acpx' ? (
              <div className="space-y-2.5">
                <div className="grid gap-2 md:grid-cols-[150px,1fr]">
                  <select
                    value={messageTargetType}
                    onChange={(event) => setMessageTargetType(event.target.value as 'task' | 'participant' | 'all')}
                    className="rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="task">发给整个任务</option>
                    <option value="participant">发给单个参与方</option>
                    <option value="all">发给全部参与方</option>
                  </select>
                  {messageTargetType === 'participant' ? (
                    <select
                      value={messageTargetParticipantKey}
                      onChange={(event) => setMessageTargetParticipantKey(event.target.value)}
                      className="rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-indigo-500"
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
                    <div className="rounded-xl border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500">
                      当前目标：{selectedTargetLabel}
                    </div>
                  )}
                </div>
                <textarea
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  rows={2}
                  className="w-full rounded-2xl border border-gray-300 px-4 py-3 text-sm focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                  placeholder="像聊天一样输入你的要求、追问、纠偏或补充信息……"
                />
                {controlError ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {controlError}
                  </div>
                ) : null}
                {composerNotice ? (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                    {composerNotice}
                  </div>
                ) : null}
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr),210px,170px]">
                  <button
                    onClick={() => void handlePrimaryAcpxSend()}
                    disabled={
                      isSending
                      || !taskRoom
                      || !messageInput.trim()
                      || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                    }
                    className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {isSending ? '发送中...' : primarySendLabel}
                  </button>
                  <button
                    onClick={() => void handleAcpxControl('interrupt_now', 'immediate')}
                    disabled={
                      isSending
                      || !taskRoom
                      || !messageInput.trim()
                      || !selectedRunCanInterrupt
                      || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                    }
                    className="rounded-xl bg-amber-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-300"
                  >
                    打断当前本地运行后发送
                  </button>
                  <button
                    onClick={() => void handleAcpxControl('stop_run', 'immediate')}
                    disabled={isSending || !taskRoom || !selectedRunCanStop}
                    className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
                  >
                    停止当前运行
                  </button>
                </div>
                <div className="text-[11px] leading-5 text-gray-500">
                  主按钮会尽量按聊天习惯工作：忙碌时先排队，不忙时直接带着这条消息启动新一轮。只有“打断当前本地运行后发送”才会主动中断本地 harness。
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  rows={4}
                  className="w-full rounded-2xl border border-gray-300 px-4 py-3 text-sm focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                  placeholder="输入消息……"
                />
                <button
                  onClick={() => void handleSendMessage()}
                  disabled={isSending || !taskRoom || !messageInput.trim()}
                  className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {isSending ? '发送中...' : primarySendLabel}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 h-full space-y-4 overflow-y-auto pr-1">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-medium text-gray-900">Run History</div>
            <div className="mt-3 max-h-[28vh] space-y-2 overflow-y-auto pr-1">
              {runSummaries.length === 0 ? (
                <div className="text-sm text-gray-500">还没有运行历史。</div>
              ) : (
                runSummaries.map((run, index) => (
                  <button
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      selectedRunId === run.id
                        ? 'border-indigo-300 bg-indigo-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-gray-900">Run {runSummaries.length - index}</div>
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
                    <div className="mt-1 text-xs text-gray-500">
                      {new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    {run.activityState || run.controlState ? (
                      <div className="mt-1 text-[11px] text-gray-500">
                        {run.activityState ? `activity=${run.activityState}` : ''}
                        {run.activityState && run.controlState ? ' · ' : ''}
                        {run.controlState ? `control=${run.controlState}` : ''}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {run.participants.map((participant) => (
                        <span
                          key={participant.id}
                          className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700"
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

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-medium text-gray-900">Selected Run Summary</div>
            <div className="mt-3 whitespace-pre-wrap text-sm text-gray-600">
              {selectedRun?.summary || selectedRun?.error || '暂无运行摘要'}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-medium text-gray-900">Participant Outcomes</div>
            <div className="mt-3 space-y-3">
              {(selectedRun?.participants || []).map((participant) => (
                <div key={participant.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900">
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
                    <div className="mt-2 text-xs text-gray-500">
                      activity: {participant.activityState}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-gray-500">
                    {participant.interruptSupported ? <span className="rounded-full bg-gray-100 px-2 py-0.5">可中断</span> : null}
                    {participant.softStopSupported ? <span className="rounded-full bg-gray-100 px-2 py-0.5">可停止</span> : null}
                    {participant.resumeSupported ? <span className="rounded-full bg-gray-100 px-2 py-0.5">可恢复重启</span> : null}
                  </div>
                  {participant.executionBackend === 'gateway_openclaw' ? (
                    <div className="mt-3 space-y-2">
                      <button
                        onClick={() => void handleParticipantConnectivityProbe(participant)}
                        disabled={participantProbeState[participant.id]?.status === 'testing'}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
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
                    <div className="mt-3 text-xs text-gray-500">
                      本地 direct harness 的独立连通性测试还未做成单独入口。
                    </div>
                  )}
                  {participant.summary ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{participant.summary}</p>
                  ) : null}
                  {participant.error ? (
                    <p className="mt-2 text-sm text-red-600">{participant.error}</p>
                  ) : null}
                  {participant.filesModified.length > 0 ? (
                    <div className="mt-2 text-xs text-gray-500">
                      修改文件: {participant.filesModified.join(', ')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
