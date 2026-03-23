'use client';

import TaskCard from './TaskCard';

interface Task {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  executionMode: 'standard' | 'acpx';
  acpxParticipants?: Array<{
    gatewayId: string;
    gatewayName?: string;
    executionBackend: 'platform_local' | 'gateway_openclaw';
    harnessType: string;
    harnessLabel?: string;
    role: string;
    agentId?: string;
    agentName?: string;
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
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskListProps {
  tasks: Task[];
  isLoading: boolean;
  onUpdateStatus: (taskId: string, status: Task['status']) => void;
  onDelete: (taskId: string) => void;
}

export default function TaskList({
  tasks,
  isLoading,
  onUpdateStatus,
  onDelete,
}: TaskListProps) {
  if (isLoading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <p className="text-gray-600 mt-4">加载中...</p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 bg-white rounded-lg shadow">
        <p className="text-gray-500">暂无任务</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onUpdateStatus={onUpdateStatus}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
