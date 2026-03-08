import { AgentGrid, DashboardStatsView } from "@/components/dashboard";
import { Agent, DashboardStats } from "@/types";

// 示例数据 - 后续从 API 获取
const sampleAgents: Agent[] = [
  {
    id: "1",
    name: "Agent-Alpha",
    type: "coding",
    location: "本地",
    capabilities: ["代码生成", "代码审查", "重构"],
    status: "online",
    lastHeartbeat: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "2",
    name: "Agent-Beta",
    type: "analysis",
    location: "云端",
    capabilities: ["数据分析", "日志解析", "监控"],
    status: "busy",
    lastHeartbeat: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "3",
    name: "Agent-Gamma",
    type: "communication",
    location: "本地",
    capabilities: ["消息处理", "通知发送", "群聊管理"],
    status: "online",
    lastHeartbeat: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "4",
    name: "Agent-Delta",
    type: "coding",
    location: "远程",
    capabilities: ["代码生成", "测试", "部署"],
    status: "offline",
    lastHeartbeat: new Date(Date.now() - 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const sampleStats: DashboardStats = {
  totalAgents: 4,
  onlineAgents: 2,
  totalNodes: 2,
  onlineNodes: 2,
  pendingTasks: 3,
  runningTasks: 1,
};

export default function DashboardPage() {
  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">Agent 平台监控看板</p>
      </header>

      <DashboardStatsView stats={sampleStats} />

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Agents</h2>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            + 新建 Agent
          </button>
        </div>
        
        <AgentGrid agents={sampleAgents} />
      </section>
    </div>
  );
}
