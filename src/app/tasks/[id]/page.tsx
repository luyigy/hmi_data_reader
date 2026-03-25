'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface TaskLog {
  taskId: string;
  taskName: string;
  status: string;
  timeline: Array<{
    timestamp: string;
    action: string;
    status: 'info' | 'success' | 'error';
    message: string;
    sequence: number;
  }>;
  metadata: {
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    executionMode?: 'standard' | 'acpx';
    workingDirectory?: string | null;
    acpxParticipants?: Array<{
      gatewayId: string;
      gatewayName?: string;
      executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
      harnessType: string;
      role: string;
    }>;
    assignedAgents: Array<{
      id: string;
      name: string;
      type: string;
      gateway?: {
        id: string;
        name: string;
      } | null;
    }>;
  };
}

interface LatestRun {
  id: string;
  orchestrationMode: string;
  status: string;
  summary?: string | null;
  error?: string | null;
  participants: Array<{
    id: string;
    gatewayName: string;
    executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
    harnessType: string;
    role: string;
    status: string;
    summary?: string | null;
    error?: string | null;
    filesModified: string[];
  }>;
}

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;
  const [log, setLog] = useState<TaskLog | null>(null);
  const [latestRun, setLatestRun] = useState<LatestRun | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void Promise.all([fetchTaskLogs(), fetchLatestRun()]).finally(() => setIsLoading(false));
  }, [taskId]);

  const fetchTaskLogs = async () => {
    const res = await fetch(`/api/tasks/${taskId}/logs`);
    const data = await res.json();
    setLog(data);
  };

  const fetchLatestRun = async () => {
    const res = await fetch(`/api/tasks/${taskId}/runs/latest`);
    const data = await res.json();
    setLatestRun(data.latestRun);
  };

  const formatTime = (dateStr?: string) =>
    dateStr
      ? new Date(dateStr).toLocaleString('zh-CN', {
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '-';

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!log) {
    return <div className="p-8 text-gray-600">无法加载任务日志</div>;
  }

  const isAcpx = log.metadata.executionMode === 'acpx';

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{log.taskName}</h1>
            <p className="mt-2 text-sm text-gray-600">
              {log.status === 'completed' ? '已完成' : log.status === 'failed' ? '失败' : '进行中'}
            </p>
          </div>
          <button
            onClick={() => window.history.back()}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm text-white hover:bg-gray-900"
          >
            返回
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr,1fr]">
        <div className="space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="text-lg font-semibold text-gray-900">{isAcpx ? 'ACPX 配置' : '分配的 Agent'}</div>
            {isAcpx ? (
              <div className="mt-4 space-y-3">
                <div className="text-sm text-gray-600">
                  工作目录: <span className="font-medium text-gray-900">{log.metadata.workingDirectory || '默认目录'}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(log.metadata.acpxParticipants || []).map((participant, index) => (
                    <span
                      key={`${participant.gatewayId}-${participant.harnessType}-${index}`}
                      className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs text-indigo-700"
                    >
                      {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : participant.executionBackend === 'remote_ssh' ? `Remote SSH · ${participant.gatewayName || participant.gatewayId}` : (participant.gatewayName || participant.gatewayId)} / {participant.harnessType}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-3">
                {log.metadata.assignedAgents.map((agent) => (
                  <div key={agent.id} className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2">
                    <div className="font-medium text-blue-900">{agent.name}</div>
                    <div className="text-sm text-blue-700">
                      {agent.type} · {agent.gateway?.name || '未分配网关'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="text-lg font-semibold text-gray-900">执行时间线</div>
            <div className="mt-4 space-y-3">
              {log.timeline.map((event) => (
                <div key={`${event.sequence}-${event.timestamp}`} className="rounded-lg border border-gray-200 p-3">
                  <div className="text-xs text-gray-500">{formatTime(event.timestamp)}</div>
                  <div className="mt-1 font-medium text-gray-900">{event.message}</div>
                  <div className="mt-1 text-xs text-gray-500">{event.action}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {isAcpx && latestRun ? (
            <>
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="text-lg font-semibold text-gray-900">运行摘要</div>
                <div className="mt-3 text-sm text-gray-600">{latestRun.summary || '暂无摘要'}</div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="text-lg font-semibold text-gray-900">参与方结果</div>
                <div className="mt-4 space-y-3">
                  {latestRun.participants.map((participant) => (
                    <div key={participant.id} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900">
                          {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : participant.executionBackend === 'remote_ssh' ? `Remote SSH · ${participant.gatewayName}` : participant.gatewayName} / {participant.harnessType}
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
                      {participant.filesModified.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {participant.filesModified.map((file) => (
                            <span key={file} className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">
                              {file}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="text-lg font-semibold text-gray-900">任务元数据</div>
              <div className="mt-4 space-y-2 text-sm text-gray-600">
                <div>创建时间: <span className="text-gray-900">{formatTime(log.metadata.createdAt)}</span></div>
                <div>开始时间: <span className="text-gray-900">{formatTime(log.metadata.startedAt)}</span></div>
                <div>完成时间: <span className="text-gray-900">{formatTime(log.metadata.completedAt)}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
