'use client';

import { useEffect, useState } from 'react';
import TaskList from '@/components/tasks/TaskList';
import TaskForm from '@/components/tasks/TaskForm';
import TaskStats from '@/components/tasks/TaskStats';

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
  updatedAt: string;
}

interface Agent {
  id: string;
  name: string;
  status: string;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchTasks();
    fetchAgents();
  }, [filter]);

  const fetchTasks = async () => {
    try {
      const url = filter === 'all'
        ? '/api/tasks?limit=50'
        : `/api/tasks?status=${filter}&limit=50`;
      
      const res = await fetch(url);
      const data = await res.json();
      if (Array.isArray(data)) {
        setTasks(data);
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      if (Array.isArray(data)) {
        setAgents(data);
      }
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    }
  };

  const handleCreateTask = async (taskData: {
    name: string;
    description?: string;
    assignedAgentIds?: string[];
  }) => {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });

      if (res.ok) {
        await fetchTasks();
        setShowForm(false);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
      alert('创建任务失败');
    }
  };

  const handleUpdateTaskStatus = async (
    taskId: string,
    status: Task['status']
  ) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (res.ok) {
        await fetchTasks();
      }
    } catch (error) {
      console.error('Failed to update task:', error);
      alert('更新任务失败');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('确定要删除这个任务吗？')) return;

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        await fetchTasks();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
      alert('删除任务失败');
    }
  };

  const stats = {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    running: tasks.filter((t) => t.status === 'running').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };

  return (
    <div>
      <header className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">任务编排</h1>
            <p className="text-gray-600 mt-2">管理和调度 Agent 任务</p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            + 新建任务
          </button>
        </div>
      </header>

      <TaskStats stats={stats} />

      <div className="mb-6">
        <div className="flex gap-2">
          {['all', 'pending', 'running', 'completed', 'failed'].map((status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={`px-4 py-2 rounded-lg transition-colors ${
                filter === status
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {status === 'all' ? '全部' : status === 'pending' ? '待处理' : status === 'running' ? '进行中' : status === 'completed' ? '已完成' : '失败'}
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <TaskForm
          agents={agents}
          onSubmit={handleCreateTask}
          onClose={() => setShowForm(false)}
        />
      )}

      <TaskList
        tasks={tasks}
        isLoading={isLoading}
        onUpdateStatus={handleUpdateTaskStatus}
        onDelete={handleDeleteTask}
      />
    </div>
  );
}
