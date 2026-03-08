import AgentCard from "@/components/dashboard/AgentCard";
import Sidebar from "@/components/layout/Sidebar";

const agents = [
  {
    id: "agent-core",
    name: "Core Orchestrator",
    status: "busy" as const,
    description: "Routing tasks across nodes and maintaining state.",
    nodesCount: 3,
    tasksCount: 8,
  },
  {
    id: "agent-reporter",
    name: "Insight Reporter",
    status: "idle" as const,
    description: "Summarizing metrics and generating weekly digests.",
    nodesCount: 1,
    tasksCount: 2,
  },
  {
    id: "agent-ops",
    name: "Ops Sentinel",
    status: "offline" as const,
    description: "Monitoring deployments and alerting on anomalies.",
    nodesCount: 0,
    tasksCount: 0,
  },
];

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-8">
          <header className="mb-8">
            <p className="text-sm uppercase tracking-widest text-slate-500">
              Dashboard
            </p>
            <h2 className="mt-2 text-3xl font-semibold">Agent Overview</h2>
            <p className="mt-2 text-sm text-slate-600">
              Monitor active agents, nodes, and queued tasks in real time.
            </p>
          </header>

          <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} {...agent} />
            ))}
          </section>

          <section className="mt-10 grid gap-6 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="text-lg font-semibold">Live Nodes</h3>
              <p className="mt-2 text-sm text-slate-600">
                4 nodes connected · 1 degraded · 0 offline
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="text-lg font-semibold">Queued Tasks</h3>
              <p className="mt-2 text-sm text-slate-600">
                12 pending · 3 running · 5 completed today
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="text-lg font-semibold">Alerts</h3>
              <p className="mt-2 text-sm text-slate-600">
                No critical alerts. Next health check in 15 minutes.
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
