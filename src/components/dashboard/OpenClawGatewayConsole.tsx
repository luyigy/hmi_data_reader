'use client';

import { Gateway } from '@/types';
import { useState } from 'react';

interface OpenClawGatewayConsoleProps {
  gateways: Gateway[];
  onRefresh?: () => void;
}

type GatewayDrafts = Record<string, string>;
type GatewayResponses = Record<string, string>;
type GatewayBusyMap = Record<string, boolean>;
type GatewayNotices = Record<string, string>;

export function OpenClawGatewayConsole({
  gateways,
  onRefresh,
}: OpenClawGatewayConsoleProps) {
  const [tokenDrafts, setTokenDrafts] = useState<GatewayDrafts>({});
  const [promptDrafts, setPromptDrafts] = useState<GatewayDrafts>({});
  const [responses, setResponses] = useState<GatewayResponses>({});
  const [savingMap, setSavingMap] = useState<GatewayBusyMap>({});
  const [runningMap, setRunningMap] = useState<GatewayBusyMap>({});
  const [errors, setErrors] = useState<GatewayResponses>({});
  const [notices, setNotices] = useState<GatewayNotices>({});

  const handleSaveToken = async (gatewayId: string) => {
    const token = tokenDrafts[gatewayId]?.trim();
    if (!token) {
      setErrors((prev) => ({ ...prev, [gatewayId]: '请先填入 OpenClaw token' }));
      return;
    }

    setSavingMap((prev) => ({ ...prev, [gatewayId]: true }));
    setErrors((prev) => ({ ...prev, [gatewayId]: '' }));
    setNotices((prev) => ({ ...prev, [gatewayId]: '' }));

    try {
      const response = await fetch(`/api/gateways/${gatewayId}/openclaw/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '保存 OpenClaw token 失败');
      }

      setTokenDrafts((prev) => ({ ...prev, [gatewayId]: '' }));
      setNotices((prev) => ({ ...prev, [gatewayId]: 'OpenClaw token 已保存' }));
      onRefresh?.();
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [gatewayId]: error instanceof Error ? error.message : '保存 OpenClaw token 失败',
      }));
    } finally {
      setSavingMap((prev) => ({ ...prev, [gatewayId]: false }));
    }
  };

  const handleRunPrompt = async (gatewayId: string) => {
    const input = (promptDrafts[gatewayId] || '').trim();
    if (!input) {
      setErrors((prev) => ({ ...prev, [gatewayId]: '请先输入 prompt' }));
      return;
    }

    setRunningMap((prev) => ({ ...prev, [gatewayId]: true }));
    setErrors((prev) => ({ ...prev, [gatewayId]: '' }));
    setNotices((prev) => ({ ...prev, [gatewayId]: '' }));

    try {
      const response = await fetch(`/api/gateways/${gatewayId}/openclaw/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input,
          agentId: 'main',
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '调用 OpenClaw 失败');
      }

      setResponses((prev) => ({
        ...prev,
        [gatewayId]: data.text || '(空回复)',
      }));
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [gatewayId]: error instanceof Error ? error.message : '调用 OpenClaw 失败',
      }));
    } finally {
      setRunningMap((prev) => ({ ...prev, [gatewayId]: false }));
    }
  };

  if (gateways.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
        暂无可用 Gateway，先注册远程网关后再测试 OpenClaw UI。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">OpenClaw Gateway Console</h2>
        <p className="mt-1 text-sm text-gray-600">
          在 UI 中为每个 Gateway 配置 OpenClaw token，并直接发 prompt 查看真实回复。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {gateways.map((gateway) => (
          <section
            key={gateway.id}
            className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{gateway.name}</h3>
                <p className="mt-1 text-xs text-gray-500">{gateway.id}</p>
                <p className="mt-2 text-sm text-gray-600">{gateway.url || '未配置 URL'}</p>
              </div>
              <div className="space-y-2 text-right text-xs">
                <div>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 font-medium ${
                      gateway.status === 'online'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {gateway.status}
                  </span>
                </div>
                <div>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 font-medium ${
                      gateway.hasOpenClawToken
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {gateway.hasOpenClawToken ? 'OpenClaw token 已配置' : 'OpenClaw token 未配置'}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                OpenClaw Token
              </label>
              <div className="flex gap-3">
                <input
                  type="password"
                  value={tokenDrafts[gateway.id] || ''}
                  onChange={(e) =>
                    setTokenDrafts((prev) => ({ ...prev, [gateway.id]: e.target.value }))
                  }
                  placeholder={
                    gateway.hasOpenClawToken
                      ? '已保存 token，如需更新请重新输入'
                      : '输入该 Gateway 的 OpenClaw token'
                  }
                  className="flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
                <button
                  onClick={() => handleSaveToken(gateway.id)}
                  disabled={!!savingMap[gateway.id]}
                  className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingMap[gateway.id]
                    ? '保存中...'
                    : gateway.hasOpenClawToken
                      ? '更新'
                      : '保存'}
                </button>
              </div>
              {notices[gateway.id] ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {notices[gateway.id]}
                </div>
              ) : null}
            </div>

            <div className="mt-5 space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                Prompt
              </label>
              <textarea
                value={promptDrafts[gateway.id] || ''}
                onChange={(e) =>
                  setPromptDrafts((prev) => ({ ...prev, [gateway.id]: e.target.value }))
                }
                rows={4}
                placeholder="例如：Please introduce yourself briefly."
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  当前固定调用 `agentId = main`
                </p>
                <button
                  onClick={() => handleRunPrompt(gateway.id)}
                  disabled={!!runningMap[gateway.id]}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {runningMap[gateway.id] ? '调用中...' : '发送到 OpenClaw'}
                </button>
              </div>
            </div>

            {errors[gateway.id] ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errors[gateway.id]}
              </div>
            ) : null}

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="mb-2 text-sm font-medium text-gray-700">Latest Response</div>
              <div className="min-h-20 whitespace-pre-wrap text-sm text-gray-800">
                {responses[gateway.id] || '还没有回复，先保存 token 再发送 prompt。'}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
