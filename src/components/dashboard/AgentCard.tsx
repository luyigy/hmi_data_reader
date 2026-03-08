'use client';

import { Agent } from '@/types';

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
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
        <div className="flex justify-between">
          <span className="text-gray-500">类型:</span>
          <span className="font-medium">{agent.type}</span>
        </div>
        
        {agent.location && (
          <div className="flex justify-between">
            <span className="text-gray-500">位置:</span>
            <span className="font-medium">{agent.location}</span>
          </div>
        )}
        
        <div className="flex justify-between">
          <span className="text-gray-500">能力:</span>
          <span className="font-medium">{agent.capabilities.length} 项</span>
        </div>
        
        <div className="mt-3">
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.slice(0, 3).map((cap, idx) => (
              <span
                key={idx}
                className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
              >
                {cap}
              </span>
            ))}
            {agent.capabilities.length > 3 && (
              <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full">
                +{agent.capabilities.length - 3}
              </span>
            )}
          </div>
        </div>
        
        <div className="pt-2 text-xs text-gray-400">
          最后心跳: {new Date(agent.lastHeartbeat).toLocaleString('zh-CN')}
        </div>
      </div>
    </div>
  );
}
