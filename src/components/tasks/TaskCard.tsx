'use client';

interface Task {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedAgents: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface TaskCardProps {
  task: Task;
  onUpdateStatus: (taskId: string, status: Task['status']) => void;
  onDelete: (taskId: string) => void;
}

export default function TaskCard({ task, onUpdateStatus, onDelete }: TaskCardProps) {
  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    running: 'bg-blue-100 text-blue-800 border-blue-300',
    completed: 'bg-green-100 text-green-800 border-green-300',
    failed: 'bg-red-100 text-red-800 border-red-300',
  };

  const statusLabels = {
    pending: '待处理',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
  };

  const formatTime = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const handleStatusChange = (newStatus: Task['status']) => {
    onUpdateStatus(task.id, newStatus);
  };

  const handleExecuteTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST',
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || '执行失败');
      }

      const result = await res.json();
      alert(`任务执行完成！\n成功：${result.successCount}\n失败：${result.failCount}`);
      
      // 刷新页面以显示最新状态
      window.location.reload();
    } catch (error) {
      console.error('Failed to execute task:', error);
      alert(`执行失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-4 max-w-4xl">
      <div className="flex items-start gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="text-base font-semibold text-gray-900 truncate">{task.name}</h3>
            <span
              className={`px-2 py-0.5 text-xs rounded-full border whitespace-nowrap ${
                statusColors[task.status]
              }`}
            >
              {statusLabels[task.status]}
            </span>
          </div>
          {task.description && (
            <p className="text-xs text-gray-600 line-clamp-2">{task.description}</p>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <a
            href={`/tasks/${task.id}/chat`}
            className="p-1.5 text-green-500 hover:text-green-700 hover:bg-green-50 rounded transition-colors"
            title="查看 Agent 通信"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </a>
          <a
            href={`/tasks/${task.id}`}
            className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
            title="查看执行日志"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </a>
          <button
            onClick={() => onDelete(task.id)}
            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
            title="删除任务"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
        <div>
          <span className="text-gray-500">创建时间:</span>
          <div className="text-gray-900 font-medium">{formatTime(task.createdAt)}</div>
        </div>
        {task.startedAt && (
          <div>
            <span className="text-gray-500">开始时间:</span>
            <div className="text-gray-900 font-medium">{formatTime(task.startedAt)}</div>
          </div>
        )}
        {task.completedAt && (
          <div>
            <span className="text-gray-500">完成时间:</span>
            <div className="text-gray-900 font-medium">{formatTime(task.completedAt)}</div>
          </div>
        )}
        <div>
          <span className="text-gray-500">Agent:</span>
          <div className="text-gray-900 font-medium">{task.assignedAgents.length} 个</div>
        </div>
      </div>

      {task.assignedAgents.length > 0 && (
        <div className="mb-4">
          <span className="text-xs text-gray-500">分配给:</span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {task.assignedAgents.map((agent) => (
              <span
                key={agent.id}
                className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full"
              >
                {agent.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {task.error && (
        <div className="mb-4 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
          <strong>错误:</strong> {task.error}
        </div>
      )}

      {task.result && (
        <div className="mb-4 p-2 bg-gray-50 border border-gray-200 rounded text-xs">
          <strong>结果:</strong>
          <details className="mt-1">
            <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-medium">
              查看结果详情
            </summary>
            <pre className="mt-2 text-gray-700 overflow-auto max-h-48 text-[10px]">
              {typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}
            </pre>
          </details>
        </div>
      )}

      <div className="border-t border-gray-200 pt-3 flex flex-wrap gap-2">
        {task.status === 'pending' && (
          <>
            <button
              onClick={() => handleExecuteTask(task.id)}
              className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700 transition-colors"
              title="执行任务并发送给分配的 Agent"
            >
              🚀 执行任务
            </button>
            <button
              onClick={() => handleStatusChange('running')}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 transition-colors"
            >
              开始
            </button>
            <button
              onClick={() => handleStatusChange('failed')}
              className="px-3 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
            >
              失败
            </button>
          </>
        )}
        {task.status === 'running' && (
          <>
            <button
              onClick={() => handleStatusChange('completed')}
              className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 transition-colors"
            >
              完成
            </button>
            <button
              onClick={() => handleStatusChange('failed')}
              className="px-3 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
            >
              失败
            </button>
          </>
        )}
        {(task.status === 'completed' || task.status === 'failed') && (
          <button
            onClick={() => handleStatusChange('pending')}
            className="px-3 py-1.5 bg-gray-600 text-white text-xs rounded hover:bg-gray-700 transition-colors"
          >
            重新开始
          </button>
        )}
      </div>
    </div>
  );
}
