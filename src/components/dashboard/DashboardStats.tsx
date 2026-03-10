'use client';

import { DashboardStats } from '@/types';

interface StatsCardProps {
  title: string;
  value: number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
}

function StatsCard({ title, value, subtitle, color = 'blue' }: StatsCardProps) {
  const colorClasses = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    green: 'bg-green-50 border-green-200 text-green-900',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-900',
    red: 'bg-red-50 border-red-200 text-red-900',
    gray: 'bg-gray-50 border-gray-200 text-gray-900',
  };

  return (
    <div className={`p-6 rounded-lg border ${colorClasses[color]}`}>
      <h3 className="text-sm font-medium opacity-80">{title}</h3>
      <p className="text-3xl font-bold mt-2">{value}</p>
      {subtitle && (
        <p className="text-sm mt-1 opacity-70">{subtitle}</p>
      )}
    </div>
  );
}

interface DashboardStatsProps {
  stats: DashboardStats;
}

export function DashboardStatsView({ stats }: DashboardStatsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <StatsCard
        title="总 Agents"
        value={stats.totalAgents}
        subtitle="全部"
        color="blue"
      />
      <StatsCard
        title="在线 Agents"
        value={stats.onlineAgents}
        subtitle="在线"
        color="green"
      />
      <StatsCard
        title="忙碌 Agents"
        value={stats.busyAgents}
        subtitle="忙碌"
        color="yellow"
      />
      <StatsCard
        title="离线 Agents"
        value={stats.offlineAgents}
        subtitle="离线"
        color="gray"
      />
    </div>
  );
}
