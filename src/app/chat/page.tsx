'use client';

import { CrossGatewayChatPanel } from '@/components/dashboard';
import { Gateway } from '@/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchGateways = async () => {
    try {
      const response = await fetch('/api/gateways');
      const data = await response.json();
      setGateways(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch gateways for chat page:', error);
      setGateways([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGateways();
  }, []);

  const availableGateways = gateways.filter((gateway) => !!gateway.url);
  const readyGatewayCount = gateways.filter(
    (gateway) => gateway.url && gateway.hasOpenClawToken
  ).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
            Conversations
          </div>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">Cross-Gateway Chat Room</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            这里承载真实的跨 Gateway 会话、transcript 和续聊操作。Dashboard 现在只负责监控和入口，
            正式对话从这里进入会更符合聊天产品的使用路径。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-slate-500">可见 Gateway</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{availableGateways.length}</div>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="text-emerald-700">可直接对话</div>
            <div className="mt-1 text-2xl font-semibold text-emerald-900">{readyGatewayCount}</div>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          {loading ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-500">
              正在加载 Gateway 会话上下文...
            </div>
          ) : (
            <CrossGatewayChatPanel gateways={availableGateways} onRefresh={fetchGateways} />
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Room Notes
            </h2>
            <div className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <p>真实 transcript、历史会话和续聊都放在这里，不再埋在 Dashboard 底部。</p>
              <p>如果某个 Gateway 的 agent 列表过旧，可以直接在聊天页里刷新。</p>
              <p>单 Gateway token 配置和联调测试保留在工具页，避免和正式会话混在一起。</p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Quick Links
            </h2>
            <div className="mt-4 space-y-3">
              <Link
                href="/"
                className="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-100"
              >
                返回 Dashboard 查看平台状态
              </Link>
              <Link
                href="/gateway-tools"
                className="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-100"
              >
                打开 Gateway Tools 做 token 配置和单次联调
              </Link>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
