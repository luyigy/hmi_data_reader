'use client';

import { Agent } from '@/types';
import { AgentCard } from './AgentCard';
import { useState, useEffect } from 'react';

interface AgentGridProps {
  agents: Agent[];
  onAgentRefresh?: () => void;
}

export function AgentGrid({ agents, onAgentRefresh }: AgentGridProps) {
  const [agentList, setAgentList] = useState<Agent[]>(agents);

  useEffect(() => {
    setAgentList(agents);
  }, [agents]);

  const handleStatusChange = async (agentId: string, newStatus: Agent['status']) => {
    // 乐观更新 UI
    setAgentList((prev) =>
      prev.map((agent) =>
        agent.id === agentId
          ? { ...agent, status: newStatus, lastHeartbeat: new Date().toISOString() }
          : agent
      )
    );

    // 调用 API 更新
    try {
      await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
        }),
      });
      
      // 通知父组件刷新
      onAgentRefresh?.();
    } catch (error) {
      console.error('Failed to update agent status:', error);
      // 失败时恢复原状态
      setAgentList(agents);
    }
  };

  if (agentList.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>暂无 Agent 数据</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {agentList.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          onStatusChange={handleStatusChange}
        />
      ))}
    </div>
  );
}
