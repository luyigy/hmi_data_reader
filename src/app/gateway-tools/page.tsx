'use client';

import { OpenClawGatewayConsole } from '@/components/dashboard';
import { Gateway } from '@/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export const dynamic = 'force-dynamic';

export default function GatewayToolsPage() {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchGateways = async () => {
    try {
      const response = await fetch('/api/gateways');
      const data = await response.json();
      setGateways(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch gateways for tools page:', error);
      setGateways([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGateways();
  }, []);

  const connectedGateways = gateways.filter((gateway) => !!gateway.url);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
            Gateway Tools
          </div>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">OpenClaw Gateway Console</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            这里是 Gateway 联调工具页，用于配置 OpenClaw token、测试单次 prompt 和检查接入状态。
            它保留调试能力，但不再承担正式多 Gateway 会话主界面。
          </p>
        </div>
        <Link
          href="/chat"
          className="inline-flex items-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          前往 Chat Room
        </Link>
      </header>

      {loading ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500">
          正在加载 Gateway 工具上下文...
        </div>
      ) : (
        <OpenClawGatewayConsole gateways={connectedGateways} onRefresh={fetchGateways} />
      )}
    </div>
  );
}
