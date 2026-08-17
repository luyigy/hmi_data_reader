'use client';

import { useEffect, useState } from 'react';
import { formatRemoteNodeLastSeen } from '@/lib/dashboard-display';

export interface RemoteRunnerNode {
  id: string;
  name: string;
  host: string;
  status: 'online' | 'offline';
  lastSeen: string | null;
  harnesses?: string[] | null;
  workspace?: string | null;
}

interface RemoteRunnersPanelProps {
  /** Bump to refetch alongside the rest of the dashboard. */
  refreshKey?: number;
}

/**
 * Remote Runners status area.
 *
 * Reads the existing /api/remote-nodes endpoint directly and stays a separate
 * section from Gateway agents: RemoteNode is its own data model and must not
 * be merged into /api/agents. The API only returns non-sensitive metadata
 * (host, lastSeen, harnesses, workspace) — never the node secret hash.
 */
export function RemoteRunnersPanel({ refreshKey = 0 }: RemoteRunnersPanelProps) {
  const [nodes, setNodes] = useState<RemoteRunnerNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/remote-nodes')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { nodes?: RemoteRunnerNode[] };
      })
      .then((data) => {
        if (!cancelled) setNodes(Array.isArray(data?.nodes) ? data.nodes : []);
      })
      .catch(() => {
        if (!cancelled) {
          setNodes([]);
          setError('无法加载 Remote Runners，请稍后刷新重试');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const onlineCount = nodes.filter((node) => node.status === 'online').length;

  return (
    <section className="mb-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Remote Runners</h2>
          <p className="mt-1 text-sm text-slate-600">
            通过 Remote Runner Gateway 接入的执行节点，独立于 Gateway Agents 展示，不合并两套数据模型。
          </p>
        </div>
        <span className="whitespace-nowrap text-sm text-slate-500">
          {onlineCount}/{nodes.length} 在线
        </span>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-gray-500">
          加载 Remote Runners...
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error}</div>
      ) : nodes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          还没有 Remote Runner 接入。完成配对并启动 runner 后，这里会出现节点连接状态。
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {nodes.map((node) => (
            <div key={node.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-900">{node.name}</h3>
                  <p className="mt-1 break-all text-xs text-slate-500">host: {node.host}</p>
                </div>
                <span
                  className={`inline-flex shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                    node.status === 'online'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {node.status === 'online' ? 'online' : 'offline'}
                </span>
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">最近连接</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {formatRemoteNodeLastSeen(node.lastSeen)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Harness</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {node.harnesses && node.harnesses.length > 0
                      ? node.harnesses.join(', ')
                      : '未上报'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Workspace</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-slate-700">
                    {node.workspace || '未上报'}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
