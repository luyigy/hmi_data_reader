import { AgentGrid, DashboardStatsView } from '@/components/dashboard';
import { prisma } from '@/lib/prisma';
import { Agent, DashboardStats } from '@/types';

export const dynamic = 'force-dynamic';

function mapAgent(agents: Awaited<ReturnType<typeof prisma.agent.findMany>>): Agent[] {
  return agents.map((agent) => {
    let capabilities: string[] = [];
    try {
      capabilities = JSON.parse(agent.capabilities || '[]');
    } catch {
      capabilities = [];
    }

    return {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      location: agent.location ?? undefined,
      capabilities,
      status: agent.status as Agent['status'],
      lastHeartbeat: agent.lastHeartbeat.toISOString(),
      nodeId: agent.nodeId ?? undefined,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });
}

export default async function DashboardPage() {
  const agents = await prisma.agent.findMany({
    orderBy: { createdAt: 'desc' },
  });

  const mappedAgents = mapAgent(agents);

  const stats: DashboardStats = {
    totalAgents: mappedAgents.length,
    onlineAgents: mappedAgents.filter((agent) => agent.status === 'online').length,
    busyAgents: mappedAgents.filter((agent) => agent.status === 'busy').length,
    offlineAgents: mappedAgents.filter((agent) => agent.status === 'offline').length,
  };

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">Agent 平台监控看板</p>
      </header>

      <DashboardStatsView stats={stats} />

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Agents</h2>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            + 新建 Agent
          </button>
        </div>

        <AgentGrid agents={mappedAgents} />
      </section>
    </div>
  );
}
