'use client';

import { Agent } from '@/types';
import { useState } from 'react';

interface AgentCardProps {
  agent: Agent;
  onStatusChange?: (agentId: string, newStatus: Agent['status']) => void;
}

export function AgentCard({ agent, onStatusChange }: AgentCardProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const statusColors = {
    online: 'bg-green-500',
    offline: 'bg-gray-400',
    busy: 'bg-yellow-500',
    error: 'bg-red-500',
  };

  const statusLabels = {
    online: '在线',
    offline: '离线',
    busy: '忙碌',
    error: '错误',
  };

  const handleStatusChange = async (newStatus: Agent['status']) => {
    if (isUpdating) return;
    
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        throw new Error('Failed to update status');
      }

      onStatusChange?.(agent.id, newStatus);
    } catch (error) {
      console.error('Failed to update agent status:', error);
      alert('更新状态失败，请重试');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200 hover:shadow-lg transition-shadow">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">{agent.name}</h3>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${statusColors[agent.status]}`}></span>
          <span className="text-sm text-gray-600">{statusLabels[agent.status]}</span>
        </div>
      </div>

      <div className="space-y-2 text-sm">
        {agent.location && (
          <div className="flex justify-between">
            <span className="text-gray-500">位置:</span>
            <span className="font-medium">{agent.location}</span>
          </div>
        )}

        <div>
          <div className="text-gray-500 mb-2">能力:</div>
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((cap, idx) => (
              <span
                key={idx}
                className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
              >
                {cap}
              </span>
            ))}
          </div>
        </div>

        <div className="pt-4 border-t border-gray-100">
          <div className="flex gap-2">
            {agent.status !== 'online' && (
              <button
                onClick={() => handleStatusChange('online')}
                disabled={isUpdating}
                className="flex-1 px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                上线
              </button>
            )}
            {agent.status !== 'offline' && (
              <button
                onClick={() => handleStatusChange('offline')}
                disabled={isUpdating}
                className="flex-1 px-3 py-1.5 bg-gray-600 text-white text-xs rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                下线
              </button>
            )}
            {agent.status !== 'busy' && (
              <button
                onClick={() => handleStatusChange('busy')}
                disabled={isUpdating}
                className="flex-1 px-3 py-1.5 bg-yellow-600 text-white text-xs rounded hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                忙碌
              </button>
            )}
          </div>
        </div>

        <div className="pt-2 text-xs text-gray-400">
          最后心跳：{new Date(agent.lastHeartbeat).toLocaleString('zh-CN')}
        </div>
      </div>
    </div>
  );
}
