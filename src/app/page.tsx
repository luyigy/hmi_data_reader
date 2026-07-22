'use client';

import {
  AgentGrid,
  DashboardStatsView,
  RegisterGatewayModal,
  CreateAgentModal,
} from '@/components/dashboard';
import { Agent, DashboardStats, Gateway } from '@/types';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { FeishuRuntimeMonitor } from '@/components/dashboard/FeishuRuntimeMonitor';

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

  const onlineGateways = gateways.filter((gateway) => gateway.status === 'online').length;
  const readyChatGateways = gateways.filter(
    (gateway) => gateway.url && gateway.hasOpenClawToken
  ).length;
  const remoteAgents = agents.filter((agent) => agent.location === 'remote').length;

  const handleRegistrationSuccess = () => {
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div key={refreshKey}>
      <header className="mb-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
              Platform Overview
            </div>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">Dashboard</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              这里保留平台监控、Gateway 和 Agent 状态，以及进入正式会话和联调工具的入口。
              长 transcript 和工具输出已经从 Dashboard 拆出，避免监控页承担聊天主界面。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              注册远程网关
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              onClick={() => setIsCreateAgentModalOpen(true)}
            >
              + 新建 Agent
            </button>
          </div>
        </div>
      </header>

      <DashboardStatsView stats={stats} />

      <FeishuRuntimeMonitor />

      <section className="mb-10 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-medium text-slate-500">在线 Gateway</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{onlineGateways}</div>
          <p className="mt-2 text-sm text-slate-600">当前处于在线状态的远程 Gateway 数量。</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
          <div className="text-sm font-medium text-emerald-700">可进入 Chat Room</div>
          <div className="mt-2 text-3xl font-semibold text-emerald-900">{readyChatGateways}</div>
          <p className="mt-2 text-sm text-emerald-800">
            已配置 URL 和 OpenClaw token，可直接参与跨 Gateway 对话。
          </p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <div className="text-sm font-medium text-amber-700">远程 Agents</div>
          <div className="mt-2 text-3xl font-semibold text-amber-900">{remoteAgents}</div>
          <p className="mt-2 text-sm text-amber-800">
            已同步到平台中的远端 agents，可作为会话编排参与者。
          </p>
        </div>
      </section>

      <section className="mb-10">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-slate-900">Quick Access</h2>
          <p className="mt-1 text-sm text-slate-600">
            Dashboard 只保留入口，不再直接承载正式聊天和联调输出。
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Link
            href="/workspaces"
            className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
          >
            <div className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
              Workspaces
            </div>
            <h3 className="mt-3 text-2xl font-semibold text-slate-900">
              进入新的多 Agent 项目工作空间
            </h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              这里是新的 workspace-first 产品线，支持按项目组织 topic、成员、Feishu 同步和持续对话。
            </p>
            <div className="mt-5 text-sm font-medium text-slate-900 group-hover:text-slate-700">
              打开 /workspaces
            </div>
          </Link>

          <Link
            href="/chat"
            className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
          >
            <div className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
              Chat Room
            </div>
            <h3 className="mt-3 text-2xl font-semibold text-slate-900">
              进入正式 Cross-Gateway Conversations
            </h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              在独立页面查看 transcript、历史会话和续聊，不再需要滚到 Dashboard 底部找最新消息。
            </p>
            <div className="mt-5 text-sm font-medium text-slate-900 group-hover:text-slate-700">
              打开 /chat
            </div>
          </Link>

          <Link
            href="/gateway-tools"
            className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
          >
            <div className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
              Gateway Tools
            </div>
            <h3 className="mt-3 text-2xl font-semibold text-slate-900">
              打开 OpenClaw Gateway Console
            </h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              用于 token 配置、单 Gateway prompt 测试和 agent 刷新，明确作为联调工具存在。
            </p>
            <div className="mt-5 text-sm font-medium text-slate-900 group-hover:text-slate-700">
              打开 /gateway-tools
            </div>
          </Link>
        </div>
      </section>

      <section className="mb-10">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-slate-900">Gateway Status</h2>
          <p className="mt-1 text-sm text-slate-600">
            这里保留平台监控视角，帮助你快速判断哪些 Gateway 已具备会话条件。
          </p>
        </div>

        {gateways.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
            还没有 Gateway 数据，先注册远程网关后这里会出现状态卡片。
          </div>
        ) : (
        <div className="grid gap-4 lg:grid-cols-3">
            {gateways.map((gateway) => (
              <div
                key={gateway.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{gateway.name}</h3>
                    <p className="mt-1 text-xs text-slate-500">{gateway.id}</p>
                    <p className="mt-3 text-sm text-slate-600">{gateway.url || '未配置 URL'}</p>
                  </div>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                      gateway.status === 'online'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {gateway.status}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 font-medium ${
                      gateway.hasOpenClawToken
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {gateway.hasOpenClawToken ? 'OpenClaw ready' : '缺少 OpenClaw token'}
                  </span>
                  <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                    Agents {gateway.agents?.length || 0}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Agents</h2>
            <p className="text-sm text-gray-600 mt-1">
              管理本地和远程网关的 Agents
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/workspaces"
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-400 hover:text-slate-900 transition-colors"
            >
              去 Workspaces
            </Link>
            <Link
              href="/chat"
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-400 hover:text-slate-900 transition-colors"
            >
              去 Chat Room
            </Link>
            <Link
              href="/gateway-tools"
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-400 hover:text-slate-900 transition-colors"
            >
              去 Gateway Tools
            </Link>
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
