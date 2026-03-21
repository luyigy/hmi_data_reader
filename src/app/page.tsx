'use client';

import {
  AgentGrid,
  CrossGatewayChatPanel,
  DashboardStatsView,
  RegisterGatewayModal,
  CreateAgentModal,
  OpenClawGatewayConsole,
} from '@/components/dashboard';
import { Agent, DashboardStats, Gateway } from '@/types';
import { useState, useEffect } from 'react';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreateAgentModalOpen, setIsCreateAgentModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchDashboardData = async () => {
    try {
      const [agentsResponse, gatewaysResponse] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/gateways'),
      ]);

      const [agentsData, gatewaysData] = await Promise.all([
        agentsResponse.json(),
        gatewaysResponse.json(),
      ]);

      setAgents(Array.isArray(agentsData) ? agentsData : []);
      setGateways(Array.isArray(gatewaysData) ? gatewaysData : []);
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
      setAgents([]);
      setGateways([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, [refreshKey]);

  const stats: DashboardStats = {
    totalAgents: agents.length,
    onlineAgents: agents.filter((agent) => agent.status === 'online').length,
    busyAgents: agents.filter((agent) => agent.status === 'busy').length,
    offlineAgents: agents.filter((agent) => agent.status === 'offline').length,
  };

  const handleRegistrationSuccess = () => {
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div key={refreshKey}>
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">Agent 平台监控看板</p>
      </header>

      <DashboardStatsView stats={stats} />

      <section>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Agents</h2>
            <p className="text-sm text-gray-600 mt-1">
              管理本地和远程网关的 Agents
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              注册远程网关
            </button>
            <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors" onClick={() => setIsCreateAgentModalOpen(true)}>
              + 新建 Agent
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-500">
            <p>加载中...</p>
          </div>
        ) : (
          <AgentGrid agents={agents} onAgentRefresh={() => setRefreshKey(prev => prev + 1)} />
        )}
      </section>

      <section className="mt-10">
        <OpenClawGatewayConsole
          gateways={gateways.filter((gateway) => !!gateway.url)}
          onRefresh={() => setRefreshKey((prev) => prev + 1)}
        />
      </section>

      <section className="mt-10">
        <CrossGatewayChatPanel
          gateways={gateways.filter((gateway) => !!gateway.url)}
          onRefresh={fetchDashboardData}
        />
      </section>

      <RegisterGatewayModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleRegistrationSuccess}
      />

      <CreateAgentModal
        isOpen={isCreateAgentModalOpen}
        onClose={() => setIsCreateAgentModalOpen(false)}
        onSuccess={handleRegistrationSuccess}
      />
    </div>
  );
}
