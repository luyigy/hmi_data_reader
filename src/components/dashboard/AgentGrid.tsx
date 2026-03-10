'use client';

import { Agent } from '@/types';
import { AgentCard } from './AgentCard';
import { useState } from 'react';

interface AgentGridProps {
  agents: Agent[];
}

export function AgentGrid({ agents }: AgentGridProps) {
  const [agentList, setAgentList] = useState<Agent[]>(agents);

  const handleStatusChange = (agentId: string, newStatus: Agent['status']) => {
    setAgentList((prev) =>
      prev.map((agent) =>
        agent.id === agentId
          ? { ...agent, status: newStatus, lastHeartbeat: new Date().toISOString() }
          : agent
      )
    );
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
