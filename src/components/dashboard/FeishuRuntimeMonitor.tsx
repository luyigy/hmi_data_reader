'use client';

import { useEffect, useState } from 'react';

type RuntimeMetrics = {
  threads: number;
  openFileDescriptors: number;
  sqliteFileDescriptors: number;
  rssMb: number;
  health: 'healthy' | 'warning' | 'critical';
};

type RuntimeStatus = {
  status: string;
  transportState?: 'connecting' | 'healthy' | 'stalled';
  pid: number | null;
  startedAt: string | null;
  metrics?: RuntimeMetrics | null;
};

const tone = {
  healthy: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  critical: 'border-red-300 bg-red-50 text-red-900',
};

export function FeishuRuntimeMonitor() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [baseline, setBaseline] = useState<RuntimeMetrics | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await fetch('/api/feishu/connection', { cache: 'no-store' }).then(
          (response) => response.json() as Promise<RuntimeStatus>
        );
        if (!active) return;
        setStatus(next);
        if (next.metrics) setBaseline((current) => current ?? next.metrics!);
      } catch {
        if (active) setStatus(null);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const metrics = status?.metrics;
  const health = status?.transportState === 'stalled'
    ? 'critical'
    : status?.transportState === 'connecting' ? 'warning' : metrics?.health ?? 'warning';
  const connectionLabel = status?.transportState === 'healthy' ? '连接正常'
    : status?.transportState === 'stalled' ? '连接异常' : '连接中';
  const values = metrics
    ? [
        ['线程', metrics.threads, baseline ? metrics.threads - baseline.threads : 0],
        ['文件句柄', metrics.openFileDescriptors, baseline ? metrics.openFileDescriptors - baseline.openFileDescriptors : 0],
        ['SQLite 句柄', metrics.sqliteFileDescriptors, baseline ? metrics.sqliteFileDescriptors - baseline.sqliteFileDescriptors : 0],
        ['RSS 内存', `${metrics.rssMb} MB`, baseline ? metrics.rssMb - baseline.rssMb : 0],
      ] as const
    : [];

  return (
    <section className={`mb-10 rounded-2xl border p-5 shadow-sm ${tone[health]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">飞书 Standalone Runtime</h2>
          <p className="mt-1 text-sm opacity-80">
            每 10 秒读取一次 /proc；线程 ≥100 或 SQLite 句柄 ≥25 预警。
          </p>
        </div>
        <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-medium">
          {metrics ? `${connectionLabel} · ${health} · PID ${status?.pid}` : `${status?.status ?? 'unavailable'} · 无指标`}
        </span>
      </div>
      {metrics ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {values.map(([label, value, delta]) => (
            <div key={label} className="rounded-xl bg-white/70 p-4">
              <div className="text-xs font-medium opacity-70">{label}</div>
              <div className="mt-1 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs opacity-70">本页打开后 Δ {delta > 0 ? '+' : ''}{delta}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm">进程未运行，或当前系统无法读取该 PID 的 /proc 指标。</p>
      )}
    </section>
  );
}
