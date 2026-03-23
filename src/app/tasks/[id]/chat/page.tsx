'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';

interface ChatMessage {
  id: string;
  timestamp: string;
  sender: 'system' | 'agent';
  senderName?: string;
  senderType?: string;
  messageType: 'info' | 'output' | 'conversation' | 'error' | 'result';
  content: string;
  details?: any;
}

interface TaskInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  assignedAgents: Array<{
    id: string;
    name: string;
    type: string;
    gateway?: {
      id: string;
      name: string;
    } | null;
  }>;
}

export default function TaskChatPage() {
  const params = useParams();
  const taskId = params.id as string;
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchTaskInfo();
    startPolling();

    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [taskId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  const startPolling = () => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    setPollingInterval(interval);
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/logs`);
      const logData = await res.json();

      const newMessages: ChatMessage[] = [];

      if (logData.metadata?.createdAt) {
        newMessages.push({
          id: 'created',
          timestamp: logData.metadata.createdAt,
          sender: 'system',
          messageType: 'info',
          content: `任务 "${logData.taskName}" 已创建`,
          details: logData.metadata,
        });
      }

      if (logData.metadata?.assignedAgents?.length > 0) {
        newMessages.push({
          id: 'assigned',
          timestamp: logData.metadata.createdAt,
          sender: 'system',
          messageType: 'info',
          content: `分配给 ${logData.metadata.assignedAgents.length} 个 Agent: ${
            logData.metadata.assignedAgents
              .map((a: any) => `${a.name} @ ${a.gateway?.name || '未分配网关'}`)
              .join(', ')
          }`,
        });
      }

      if (logData.metadata?.startedAt) {
        newMessages.push({
          id: 'started',
          timestamp: logData.metadata.startedAt,
          sender: 'system',
          messageType: 'info',
          content: '🚀 任务开始执行',
        });
      }

      if (logData.executionLogs && logData.executionLogs.length > 0) {
        logData.executionLogs.forEach((log: any, index: number) => {
          newMessages.push({
            id: `exec-${index}`,
            timestamp: log.timestamp,
            sender: 'agent',
            senderName: log.agentName,
            senderType: log.agentType || 'coding',
            messageType: 'output',
            content: '开始执行任务...',
            details: log,
          });

          if (log.details) {
            newMessages.push({
              id: `result-${index}`,
              timestamp: log.timestamp,
              sender: 'agent',
              senderName: log.agentName,
              senderType: log.agentType || 'coding',
              messageType: 'result',
              content: log.message || '执行完成',
              details: log.details,
            });
          }

          if (log.status === 'error') {
            newMessages.push({
              id: `error-${index}`,
              timestamp: log.timestamp,
              sender: 'agent',
              senderName: log.agentName,
              senderType: log.agentType || 'coding',
              messageType: 'error',
              content: log.error || '执行失败',
            });
          }
        });
      }

      if (logData.metadata?.completedAt) {
        newMessages.push({
          id: 'completed',
          timestamp: logData.metadata.completedAt,
          sender: 'system',
          messageType: logData.status === 'completed' ? 'result' : 'error',
          content: logData.status === 'completed'
            ? '✅ 任务执行完成'
            : `❌ 任务执行失败：${logData.error || '未知错误'}`,
          details: logData.result,
        });
      }

      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const uniqueNew = newMessages.filter((m) => !existingIds.has(m.id));
        if (uniqueNew.length === 0) return prev;
        return [...prev, ...uniqueNew];
      });

      if (logData.status === 'completed' || logData.status === 'failed') {
        setIsConnected(false);
        if (pollingInterval) {
          clearInterval(pollingInterval);
        }
      } else {
        setIsConnected(true);
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getMessageColor = (messageType: string) => {
    switch (messageType) {
      case 'info':
        return 'bg-gray-100 border-gray-300';
      case 'output':
        return 'bg-blue-50 border-blue-300';
      case 'conversation':
        return 'bg-purple-50 border-purple-300';
      case 'result':
        return 'bg-green-50 border-green-300';
      case 'error':
        return 'bg-red-50 border-red-300';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="text-gray-600 mt-4">加载聊天...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Agent 实时通信</h1>
              <p className="text-gray-600 mt-1">{task?.name}</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></div>
                <span className="text-sm text-gray-600">
                  {isConnected ? '实时连接中' : '已完成'}
                </span>
              </div>
              <a
                href={`/tasks/${taskId}`}
                className="px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors"
              >
                查看日志
              </a>
            </div>
          </div>
        </div>

        {task?.assignedAgents && task.assignedAgents.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">参与 Agent</h3>
            <div className="flex flex-wrap gap-2">
              {task.assignedAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-sm"
                >
                  <span className="font-medium text-blue-900">{agent.name}</span>
                  <span className="text-blue-600 ml-2">({agent.type} · {agent.gateway?.name || '未分配网关'})</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">通信记录</h2>
          </div>

          <div className="p-6 space-y-4 max-h-[600px] overflow-y-auto">
            {messages.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>等待任务执行...</p>
                <p className="text-sm mt-2">实时监听 Agent 通信中</p>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`rounded-lg border-l-4 p-4 ${getMessageColor(message.messageType)}`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {message.sender === 'agent' ? (
                        <>
                          <span className="text-2xl">🤖</span>
                          <div>
                            <div className="font-semibold text-gray-900">
                              {message.senderName}
                            </div>
                            <div className="text-xs text-gray-500">
                              {message.senderType} Agent
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-2xl">ℹ️</span>
                          <span className="font-semibold text-gray-700">系统</span>
                        </>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatTime(message.timestamp)}
                    </div>
                  </div>

                  <div className="text-gray-800 mb-2">
                    {message.content}
                  </div>

                  {message.details && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-medium">
                        📄 查看详细输出
                      </summary>
                      <pre className="mt-2 bg-white p-3 rounded border border-gray-200 overflow-auto max-h-64 text-xs">
                        {JSON.stringify(message.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
