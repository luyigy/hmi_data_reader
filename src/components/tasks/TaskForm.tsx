'use client';

import { useState } from 'react';

interface Agent {
  id: string;
  name: string;
  status: string;
  gateway?: {
    id: string;
    name: string;
  } | null;
}

interface TaskFormProps {
  agents: Agent[];
  onSubmit: (data: {
    name: string;
    description?: string;
    assignedAgentIds?: string[];
  }) => void;
  onClose: () => void;
}

export default function TaskForm({ agents, onSubmit, onClose }: TaskFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert('请输入任务名称');
      return;
    }

    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      assignedAgentIds: selectedAgents.length > 0 ? selectedAgents : undefined,
    });
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">新建任务</h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              任务名称 *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="例如：数据分析任务"
              autoFocus
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              任务描述
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="任务详细描述..."
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              分配给 Agent
            </label>
            <div className="max-h-48 overflow-y-auto border border-gray-300 rounded-lg p-2">
              {agents.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">暂无可用 Agent</p>
              ) : (
                agents.map((agent) => (
                  <label
                    key={agent.id}
                    className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAgents.includes(agent.id)}
                      onChange={() => toggleAgent(agent.id)}
                      className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-gray-700">{agent.name}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                          {agent.gateway?.name || '未分配网关'}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        agent.status === 'online'
                          ? 'bg-green-100 text-green-800'
                          : agent.status === 'busy'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {agent.status === 'online' ? '在线' : agent.status === 'busy' ? '忙碌' : '离线'}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              创建任务
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
