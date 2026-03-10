interface TaskStatsProps {
  stats: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
}

export default function TaskStats({ stats }: TaskStatsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
      <div className="bg-white rounded-lg shadow p-4">
        <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
        <div className="text-sm text-gray-600">总任务</div>
      </div>
      <div className="bg-yellow-50 rounded-lg shadow p-4">
        <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
        <div className="text-sm text-yellow-600">待处理</div>
      </div>
      <div className="bg-blue-50 rounded-lg shadow p-4">
        <div className="text-2xl font-bold text-blue-600">{stats.running}</div>
        <div className="text-sm text-blue-600">进行中</div>
      </div>
      <div className="bg-green-50 rounded-lg shadow p-4">
        <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
        <div className="text-sm text-green-600">已完成</div>
      </div>
      <div className="bg-red-50 rounded-lg shadow p-4">
        <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
        <div className="text-sm text-red-600">失败</div>
      </div>
    </div>
  );
}
