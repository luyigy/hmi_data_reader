'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSocketClient, type ChatMessage } from '@/lib/websocket-client';

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
  const [standardMessages, setStandardMessages] = useState<StandardLogMessage[]>([]);
  const [runSummaries, setRunSummaries] = useState<TaskRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<SelectedRunResponse['latestRun']>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const roomEndRef = useRef<HTMLDivElement>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);
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
    roomEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [roomMessages]);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedRun]);

  useEffect(() => {
    if (!task || !taskRoom) {
      return;
    }

    void fetch('/api/socket');
    const socket = getSocketClient();
    if (!socket) {
      return;
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit('chat:join', { user: taskRoomUser, roomId: taskRoom.id });

    if (task.executionMode === 'acpx') {
      socket.emit('task-run:join', { taskId });
    }

    setIsConnected(true);

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
      setRunSummaries((prev) => {
        const existing = prev.find((run) => run.id === event.taskRunId);
        if (!existing) {
          return [
            {
              id: event.taskRunId,
              mode: 'acpx',
              orchestrationMode: 'staged',
              status:
                event.eventType === 'run_completed'
                  ? 'completed'
                  : event.eventType === 'run_interrupted'
                  ? 'interrupted'
                  : event.eventType === 'run_stopped'
                  ? 'stopped'
                  : event.eventType === 'run_failed'
                  ? 'failed'
                  : 'running',
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
                  event.eventType === 'run_completed'
                    ? 'completed'
                    : event.eventType === 'run_interrupted'
                    ? 'interrupted'
                    : event.eventType === 'run_stopped'
                    ? 'stopped'
                    : event.eventType === 'run_failed'
                    ? 'failed'
                    : run.status,
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
            event.eventType === 'run_completed'
              ? 'completed'
              : event.eventType === 'run_interrupted'
              ? 'interrupted'
              : event.eventType === 'run_stopped'
              ? 'stopped'
              : event.eventType === 'run_failed'
              ? 'failed'
              : prev.status,
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

    socket.on('chat:message', handleChatMessage);
    socket.on('task-run:event', handleRunEvent);

    return () => {
      socket.off('chat:message', handleChatMessage);
      socket.off('task-run:event', handleRunEvent);
    };
  }, [task, taskRoom, taskId, selectedRunId]);

  const selectedRunEvents = useMemo(() => selectedRun?.events || [], [selectedRun]);

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
    try {
      const socket = getSocketClient();
      const optimisticMessage: ChatMessage = {
        id: `temp-${Date.now()}`,
        roomId: taskRoom.id,
        user: taskRoomUser,
        content,
        createdAt: new Date().toISOString(),
      };

      setRoomMessages((prev) => [...prev, optimisticMessage]);
      setMessageInput('');

      if (socket) {
        socket.emit('chat:message', {
          roomId: taskRoom.id,
          user: taskRoomUser,
          content,
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
    deliveryMode: 'queued' | 'immediate'
  ) => {
    if (!taskRoom || !task) {
      return;
    }

    const content = messageInput.trim();
    if ((action === 'queue_message' || action === 'interrupt_now') && !content) {
      return;
    }

    setIsSending(true);
    setControlError(null);
    try {
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
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '发送控制请求失败');
      }

      setMessageInput('');
      await fetchRoomMessages(taskRoom.id);
      await fetchRuns();
      if (selectedRunId) {
        await fetchSelectedRun(selectedRunId);
      }
      await fetchTaskInfo();
    } catch (error) {
      console.error('Failed to send ACPX control message:', error);
      setControlError(error instanceof Error ? error.message : '发送控制请求失败');
    } finally {
      setIsSending(false);
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
    && selectedRun.participants.some((participant) => participant.interruptSupported);
  const selectedRunCanStop = selectedRun?.status === 'running'
    && selectedRun.participants.some((participant) => participant.softStopSupported || participant.interruptSupported);

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!task) {
    return <div className="p-8 text-gray-600">任务不存在</div>;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{task.name}</h1>
            <p className="mt-2 text-sm text-gray-600">
              {task.executionMode === 'acpx' ? 'ACPX Task Room' : '任务执行日志'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className={`rounded-full px-3 py-1 text-xs ${isConnected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
              {isConnected ? '实时连接中' : '等待刷新'}
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
          <div className="mt-4 flex flex-wrap gap-2">
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

        {task.executionMode === 'acpx' ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            这里现在是 task room。你可以发排队消息，也可以对本地运行中的 harness 发“立即介入 / 停止运行”请求。第一版控制能力目前优先支持本地 harness，远端 gateway 会先记录控制请求并在后续阶段处理。
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr,1.5fr,1fr]">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-gray-900">Task Room</div>
            {taskRoom ? (
              <span className="text-xs text-gray-500">{taskRoom.name}</span>
            ) : null}
          </div>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-2">
            {roomMessages.length === 0 ? (
              <div className="text-sm text-gray-500">还没有房间消息。你可以先和参与方约定策略，再开始运行。</div>
            ) : (
              roomMessages.map((message) => (
                <div key={message.id} className={`rounded-lg p-3 text-sm ${
                  message.user.id === taskRoomUser.id
                    ? 'bg-blue-50 text-blue-900'
                    : message.user.id === 'system'
                    ? 'bg-gray-100 text-gray-800'
                    : 'bg-emerald-50 text-emerald-900'
                }`}>
                  <div className="mb-1 text-xs text-gray-500">
                    {message.user.name} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                </div>
              ))
            )}
            <div ref={roomEndRef} />
          </div>

          <div className="mt-4 space-y-2">
            <textarea
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-indigo-500"
              placeholder="补充任务要求、纠偏、提醒某个参与方先做计划再动手……"
            />
            {controlError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {controlError}
              </div>
            ) : null}
            {task.executionMode === 'acpx' ? (
              <div className="grid gap-2">
                <button
                  onClick={() => void handleAcpxControl('queue_message', 'queued')}
                  disabled={isSending || !taskRoom || !messageInput.trim()}
                  className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {isSending ? '发送中...' : '排队消息'}
                </button>
                <button
                  onClick={() => void handleAcpxControl('interrupt_now', 'immediate')}
                  disabled={isSending || !taskRoom || !messageInput.trim() || !selectedRunCanInterrupt}
                  className="w-full rounded-lg bg-amber-600 px-4 py-2 text-sm text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-300"
                >
                  立即介入并中断当前本地运行
                </button>
                <button
                  onClick={() => void handleAcpxControl('stop_run', 'immediate')}
                  disabled={isSending || !taskRoom || !selectedRunCanStop}
                  className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
                >
                  紧急停止当前 Run
                </button>
              </div>
            ) : (
              <button
                onClick={() => void handleSendMessage()}
                disabled={isSending || !taskRoom || !messageInput.trim()}
                className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isSending ? '发送中...' : '发送到 Task Room'}
              </button>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-slate-950 p-4 text-sm text-slate-100 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-slate-400">Selected Run Console</div>
            {selectedRun ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                  {selectedRun.status}
                </span>
                {selectedRun.activityState ? (
                  <span className="rounded-full bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                    activity: {selectedRun.activityState}
                  </span>
                ) : null}
                {selectedRun.controlState ? (
                  <span className="rounded-full bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                    control: {selectedRun.controlState}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {task.executionMode !== 'acpx' ? (
            <div className="space-y-3">
              {standardMessages.map((message) => (
                <div key={message.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <div className="mb-1 text-xs text-slate-400">
                    {new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}
                    {message.senderName ? ` · ${message.senderName}` : ''}
                  </div>
                  <div className={message.messageType === 'error' ? 'text-red-300' : 'text-slate-100'}>
                    {message.content}
                  </div>
                </div>
              ))}
            </div>
          ) : selectedRunEvents.length === 0 ? (
            <div className="text-slate-400">还没有选中的 run。开始一次运行后，这里会显示完整事件流。</div>
          ) : (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-2 font-mono text-xs">
              {selectedRunEvents.map((event) => (
                <div key={event.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    <span className="rounded-full bg-slate-800 px-2 py-0.5">{event.eventType}</span>
                    {event.participant ? (
                      <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-indigo-200">
                        {event.participant.role} · {event.participant.executionBackend === 'platform_local' ? 'Platform Local' : event.participant.gatewayName} / {event.participant.harnessType}
                      </span>
                    ) : null}
                  </div>
                  <pre className={`whitespace-pre-wrap break-words ${event.stream === 'stderr' ? 'text-red-300' : 'text-slate-100'}`}>
                    {event.content}
                  </pre>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          )}
        </div>

        <div className="space-y-4">
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
