'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSocketClient } from '@/lib/websocket-client';

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
  assignedAgents: AgentInfo[];
  acpxParticipants?: AcpxParticipantSpec[];
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
  summary?: string | null;
  error?: string | null;
  filesModified: string[];
}

interface LatestRunResponse {
  taskId: string;
  executionMode: 'standard' | 'acpx';
  latestRun: {
    id: string;
    orchestrationMode: string;
    status: string;
    summary?: string | null;
    error?: string | null;
    participants: TaskRunParticipant[];
    events: TaskRunEvent[];
  } | null;
}

export default function TaskChatPage() {
  const params = useParams();
  const taskId = params.id as string;
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [standardMessages, setStandardMessages] = useState<StandardLogMessage[]>([]);
  const [latestRun, setLatestRun] = useState<LatestRunResponse['latestRun']>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
    if (!task) return;

    if (task.executionMode === 'acpx') {
      void fetchLatestRun();
      void initSocket();
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
  }, [task, taskId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [standardMessages, latestRun]);

  const groupedEvents = useMemo(() => {
    if (!latestRun) return [];
    return latestRun.events;
  }, [latestRun]);

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
        logData.executionLogs.forEach((log: any, index: number) => {
          newMessages.push({
            id: `result-${index}`,
            timestamp: log.timestamp,
            sender: 'agent',
            senderName: log.agentName,
            messageType: log.status === 'error' ? 'error' : 'result',
            content: log.message || '执行完成',
          });
        });
      }

      setStandardMessages(newMessages);
      setIsConnected(logData.status !== 'completed' && logData.status !== 'failed');
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    }
  };

  const fetchLatestRun = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/runs/latest`);
      const data: LatestRunResponse = await res.json();
      setLatestRun(data.latestRun);
      if (data.latestRun) {
        setIsConnected(data.latestRun.status === 'running' || data.latestRun.status === 'pending');
      }
    } catch (error) {
      console.error('Failed to fetch latest run:', error);
    }
  };

  const initSocket = async () => {
    await fetch('/api/socket');
    const socket = getSocketClient();
    if (!socket) return;

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit('task-run:join', { taskId });
    setIsConnected(true);

    const handleEvent = (event: TaskRunEvent) => {
      setLatestRun((prev) => {
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
              : event.eventType === 'run_failed'
              ? 'failed'
              : prev.status,
          events: [...prev.events, event].sort((a, b) => a.sequence - b.sequence),
        };
      });

      if (event.eventType === 'run_completed' || event.eventType === 'run_failed') {
        setIsConnected(false);
        void fetchLatestRun();
      }
    };

    socket.on('task-run:event', handleEvent);

    return () => {
      socket.off('task-run:event', handleEvent);
    };
  };

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!task) {
    return <div className="p-8 text-gray-600">任务不存在</div>;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{task.name}</h1>
            <p className="mt-2 text-sm text-gray-600">
              {task.executionMode === 'acpx' ? 'ACPX 执行控制台' : '标准任务执行日志'}
            </p>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs ${isConnected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
            {isConnected ? '实时连接中' : '等待刷新'}
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
      </div>

      {task.executionMode === 'acpx' ? (
        <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
          <div className="rounded-xl border border-gray-200 bg-slate-950 p-4 text-sm text-slate-100 shadow-sm">
            <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">Live Console</div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-2 font-mono text-xs">
              {groupedEvents.length === 0 ? (
                <div className="text-slate-400">还没有运行事件。执行任务后，这里会显示每个参与方的输出。</div>
              ) : (
                groupedEvents.map((event) => (
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
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-gray-900">运行摘要</div>
              <div className="mt-3 text-sm text-gray-600">
                {latestRun?.summary || '暂无运行摘要'}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-gray-900">参与方结果</div>
              <div className="mt-3 space-y-3">
                {(latestRun?.participants || []).map((participant) => (
                  <div key={participant.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">
                          {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : participant.gatewayName} / {participant.harnessType}
                        </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        participant.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : participant.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {participant.status}
                      </span>
                    </div>
                    {participant.summary ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{participant.summary}</p>
                    ) : null}
                    {participant.error ? (
                      <p className="mt-2 text-sm text-red-600">{participant.error}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="space-y-3">
            {standardMessages.map((message) => (
              <div key={message.id} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-1 text-xs text-gray-500">
                  {new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}
                  {message.senderName ? ` · ${message.senderName}` : ''}
                </div>
                <div className={message.messageType === 'error' ? 'text-red-600' : 'text-gray-800'}>
                  {message.content}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
