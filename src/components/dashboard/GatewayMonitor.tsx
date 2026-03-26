'use client';

import { useState, useEffect } from 'react';

export interface GatewayHealthStatus {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline' | 'busy' | 'unhealthy';
  healthCheck: {
    success: boolean;
    latencyMs: number;
    statusCode: number;
    lastChecked: string;
  };
  resources?: {
    cpu?: number;
    memory?: number;
    disk?: number;
  };
  agents?: Array<{
    id: string;
    name: string;
    status: 'online' | 'offline' | 'busy';
  }>;
}

interface GatewayMonitorProps {
  refreshInterval?: number; // 刷新间隔（毫秒），默认 30000ms
}

function StatusIndicator({ status }: { status: GatewayHealthStatus['status'] }) {
  const statusConfig = {
    online: { color: 'bg-green-500', label: '在线', textColor: 'text-green-700' },
    offline: { color: 'bg-red-500', label: '离线', textColor: 'text-red-700' },
    busy: { color: 'bg-yellow-500', label: '忙碌', textColor: 'text-yellow-700' },
    unhealthy: { color: 'bg-orange-500', label: '异常', textColor: 'text-orange-700' },
  };

  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2">
      <span className={`w-3 h-3 rounded-full ${config.color} animate-pulse`} />
      <span className={`font-medium ${config.textColor}`}>{config.label}</span>
    </div>
  );
}

function LatencyBadge({ latencyMs }: { latencyMs: number }) {
  let colorClass = 'bg-green-100 text-green-800';
  
  if (latencyMs > 500) {
    colorClass = 'bg-red-100 text-red-800';
  } else if (latencyMs > 200) {
    colorClass = 'bg-yellow-100 text-yellow-800';
  }

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colorClass}`}>
      {latencyMs}ms
    </span>
  );
}

function ResourceBar({ 
  label, 
  value, 
  max = 100 
}: { 
  label: string; 
  value?: number; 
  max?: number;
}) {
  if (value === undefined) {
    return null;
  }

  const percentage = Math.min((value / max) * 100, 100);
  
  let colorClass = 'bg-green-500';
  if (percentage > 80) {
    colorClass = 'bg-red-500';
  } else if (percentage > 60) {
    colorClass = 'bg-yellow-500';
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-12 text-gray-600">{label}</span>
      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div 
          className={`h-full ${colorClass} transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="w-12 text-right text-gray-600">{value.toFixed(0)}%</span>
    </div>
  );
}

function GatewayCard({ gateway }: { gateway: GatewayHealthStatus }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <StatusIndicator status={gateway.status} />
            <h3 className="text-lg font-semibold text-gray-900">{gateway.name}</h3>
          </div>
          <p className="text-sm text-gray-500 font-mono">{gateway.url}</p>
        </div>
        <div className="flex items-center gap-2">
          <LatencyBadge latencyMs={gateway.healthCheck.latencyMs} />
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title={expanded ? '收起' : '展开详情'}
          >
            <svg
              className={`w-5 h-5 text-gray-500 transform transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm text-gray-600 mb-3">
        <div className="flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>状态码：{gateway.healthCheck.statusCode}</span>
        </div>
        <div className="flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>最后检查：{new Date(gateway.healthCheck.lastChecked).toLocaleTimeString()}</span>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
          {gateway.resources && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-gray-700">资源使用</h4>
              <ResourceBar label="CPU" value={gateway.resources.cpu} />
              <ResourceBar label="内存" value={gateway.resources.memory} />
              <ResourceBar label="磁盘" value={gateway.resources.disk} />
            </div>
          )}

          {gateway.agents && gateway.agents.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Agents ({gateway.agents.length})
              </h4>
              <div className="grid grid-cols-1 gap-2">
                {gateway.agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <span className="text-sm text-gray-700">{agent.name}</span>
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      agent.status === 'online' ? 'bg-green-100 text-green-700' :
                      agent.status === 'busy' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {agent.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GatewayMonitor({ refreshInterval = 30000 }: GatewayMonitorProps) {
  const [gateways, setGateways] = useState<GatewayHealthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchGateways = async () => {
    try {
      const response = await fetch('/api/gateways');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();

      // 获取每个 gateway 的健康状态
      const healthPromises = data.map(async (gw: any) => {
        try {
          const healthResponse = await fetch(`/api/gateways/${gw.id}/health`);
          const healthData = await healthResponse.json();
          
          return {
            id: gw.id,
            name: gw.name,
            url: gw.url,
            status: gw.status || 'offline',
            healthCheck: {
              success: healthData.success,
              latencyMs: healthData.latencyMs || 0,
              statusCode: healthData.statusCode || 0,
              lastChecked: healthData.lastChecked || new Date().toISOString(),
            },
            resources: gw.resources,
            agents: gw.agents?.map((agent: any) => ({
              id: agent.id,
              name: agent.name,
              status: agent.status,
            })),
          } as GatewayHealthStatus;
        } catch (err) {
          // 健康检查失败，返回基本信息
          return {
            id: gw.id,
            name: gw.name,
            url: gw.url,
            status: 'offline' as const,
            healthCheck: {
              success: false,
              latencyMs: 0,
              statusCode: 0,
              lastChecked: new Date().toISOString(),
            },
            resources: gw.resources,
            agents: gw.agents?.map((agent: any) => ({
              id: agent.id,
              name: agent.name,
              status: agent.status,
            })),
          } as GatewayHealthStatus;
        }
      });

      const gatewaysWithHealth = await Promise.all(healthPromises);
      setGateways(gatewaysWithHealth);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch gateways');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGateways();
    
    const timer = setInterval(fetchGateways, refreshInterval);
    return () => clearInterval(timer);
  }, [refreshInterval]);

  const onlineCount = gateways.filter(g => g.status === 'online').length;
  const offlineCount = gateways.filter(g => g.status === 'offline').length;
  const unhealthyCount = gateways.filter(g => g.status === 'unhealthy' || g.status === 'busy').length;

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
        <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-gray-600">加载 Gateway 状态...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-center gap-3 text-red-700 mb-2">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="font-semibold">加载失败</h3>
        </div>
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchGateways}
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 头部统计 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Gateway 监控</h2>
            <p className="text-sm text-gray-600 mt-1">
              实时监控 Gateway 健康状态（每 30 秒自动刷新）
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600">
              最后刷新：{lastRefresh.toLocaleTimeString()}
            </div>
            <button
              onClick={fetchGateways}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="手动刷新"
            >
              <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* 状态统计 */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-green-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-green-700">{onlineCount}</div>
            <div className="text-sm text-green-600">在线</div>
          </div>
          <div className="bg-yellow-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-yellow-700">{unhealthyCount}</div>
            <div className="text-sm text-yellow-600">忙碌/异常</div>
          </div>
          <div className="bg-red-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-red-700">{offlineCount}</div>
            <div className="text-sm text-red-600">离线</div>
          </div>
        </div>
      </div>

      {/* Gateway 列表 */}
      {gateways.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <svg className="w-12 h-12 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <p className="text-gray-600">暂无 Gateway</p>
          <p className="text-sm text-gray-500 mt-2">请先注册远程网关</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {gateways.map((gateway) => (
            <GatewayCard key={gateway.id} gateway={gateway} />
          ))}
        </div>
      )}
    </div>
  );
}
