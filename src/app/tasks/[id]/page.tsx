'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface TimelineEvent {
  timestamp: string;
  action: string;
  status: 'info' | 'success' | 'error';
  message: string;
  details?: any;
  duration?: number;
  sequence: number;
}

interface TaskLog {
  taskId: string;
  taskName: string;
  status: string;
  timeline: TimelineEvent[];
  executionLogs: any[];
  metadata: {
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    assignedAgents: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  };
}

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;
  const [log, setLog] = useState<TaskLog | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);

  useEffect(() => {
    fetchTaskLogs();
  }, [taskId]);

  const fetchTaskLogs = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/logs`);
      const data = await res.json();
      setLog(data);
    } catch (error) {
      console.error('Failed to fetch task logs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-100 border-green-500 text-green-800';
      case 'error':
        return 'bg-red-100 border-red-500 text-red-800';
      default:
        return 'bg-blue-100 border-blue-500 text-blue-800';
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'task_created':
        return '📝';
      case 'task_started':
        return '🚀';
      case 'execute_task':
        return '⚙️';
      case 'task_completed':
        return '✅';
      default:
        return 'ℹ️';
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="text-gray-600 mt-4">加载日志...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!log) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-6xl mx-auto">
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-500">无法加载任务日志</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">任务执行日志</h1>
              <p className="text-gray-600 mt-2">
                {log.taskName} - {log.status === 'completed' ? '✅ 已完成' : log.status === 'failed' ? '❌ 失败' : '⏳ 进行中'}
              </p>
            </div>
            <button
              onClick={() => window.history.back()}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              ← 返回
            </button>
          </div>
        </div>

        {/* Assigned Agents */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">分配的 Agent</h2>
          <div className="flex flex-wrap gap-3">
            {log.metadata.assignedAgents.map((agent) => (
              <div
                key={agent.id}
                className="px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg"
              >
                <div className="font-medium text-blue-900">{agent.name}</div>
                <div className="text-sm text-blue-600">{agent.type}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Timeline */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">执行时间线</h2>
            <div className="space-y-4">
              {log.timeline.map((event, index) => (
                <div
                  key={index}
                  className={`relative pl-8 pb-4 border-l-2 ${
                    event.status === 'success'
                      ? 'border-green-500'
                      : event.status === 'error'
                      ? 'border-red-500'
                      : 'border-blue-500'
                  } ${
                    index !== log.timeline.length - 1 ? 'mb-4' : ''
                  } cursor-pointer hover:bg-gray-50 rounded p-2 transition-colors ${
                    selectedEvent === event ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => setSelectedEvent(event)}
                >
                  <div
                    className={`absolute -left-3 top-0 w-6 h-6 rounded-full flex items-center justify-center text-sm ${
                      event.status === 'success'
                        ? 'bg-green-500 text-white'
                        : event.status === 'error'
                        ? 'bg-red-500 text-white'
                        : 'bg-blue-500 text-white'
                    }`}
                  >
                    {getActionIcon(event.action)}
                  </div>
                  
                  <div className="text-sm text-gray-500 mb-1">
                    {formatTime(event.timestamp)}
                  </div>
                  <div className="font-medium text-gray-900 mb-1">
                    {event.message}
                  </div>
                  {event.duration && (
                    <div className="text-xs text-gray-500">
                      耗时：{formatDuration(event.duration)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Event Details */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              详细信息 {selectedEvent && `- ${selectedEvent.message}`}
            </h2>
            
            {selectedEvent ? (
              <div>
                <div className="mb-4">
                  <div className="text-sm text-gray-500 mb-2">时间戳</div>
                  <div className="font-mono text-sm bg-gray-50 p-2 rounded">
                    {formatTime(selectedEvent.timestamp)}
                  </div>
                </div>

                <div className="mb-4">
                  <div className="text-sm text-gray-500 mb-2">动作</div>
                  <div className="font-medium text-gray-900">
                    {selectedEvent.action}
                  </div>
                </div>

                <div className="mb-4">
                  <div className="text-sm text-gray-500 mb-2">状态</div>
                  <span
                    className={`inline-block px-3 py-1 rounded-full text-sm ${getStatusColor(
                      selectedEvent.status
                    )}`}
                  >
                    {selectedEvent.status}
                  </span>
                </div>

                {selectedEvent.details && (
                  <div className="mb-4">
                    <div className="text-sm text-gray-500 mb-2">详细信息</div>
                    <pre className="text-sm bg-gray-50 p-4 rounded overflow-auto max-h-96">
                      {JSON.stringify(selectedEvent.details, null, 2)}
                    </pre>
                  </div>
                )}

                {selectedEvent.duration && (
                  <div className="mb-4">
                    <div className="text-sm text-gray-500 mb-2">执行耗时</div>
                    <div className="font-mono text-sm bg-gray-50 p-2 rounded">
                      {formatDuration(selectedEvent.duration)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <p>点击时间线上的事件查看详情</p>
              </div>
            )}
          </div>
        </div>

        {/* Agent Communication Log */}
        <div className="bg-white rounded-lg shadow p-6 mt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Agent 通信日志</h2>
          {log.executionLogs.length > 0 ? (
            <div className="space-y-4">
              {log.executionLogs.map((log, index) => (
                <div
                  key={index}
                  className={`border-l-4 pl-4 py-2 ${
                    log.status === 'success'
                      ? 'border-green-500 bg-green-50'
                      : 'border-red-500 bg-red-50'
                  } rounded`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium text-gray-900">
                      {log.agentName}
                    </div>
                    <div className="text-sm text-gray-500">
                      {formatTime(log.timestamp)}
                    </div>
                  </div>
                  <div className="text-sm text-gray-700 mb-2">
                    {log.message}
                  </div>
                  {log.details && Object.keys(log.details).length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                        查看详细结果
                      </summary>
                      <pre className="mt-2 bg-white p-3 rounded overflow-auto max-h-64">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </details>
                  )}
                  {log.duration && (
                    <div className="text-xs text-gray-500 mt-2">
                      耗时：{formatDuration(log.duration)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <p>暂无执行日志</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
