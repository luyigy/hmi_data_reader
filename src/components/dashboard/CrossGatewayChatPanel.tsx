'use client';

import { Gateway, GatewayAgentSummary } from '@/types';
import { useEffect, useMemo, useState } from 'react';

interface CrossGatewayChatPanelProps {
  gateways: Gateway[];
  onRefresh?: () => Promise<void> | void;
}

interface TranscriptMessage {
  speaker: string;
  gatewayId: string | null;
  agentId?: string | null;
  text: string;
}

interface SavedChatSession {
  id: string;
  fromGatewayId: string;
  toGatewayId: string;
  fromAgentId: string;
  toAgentId: string;
  prompt: string;
  turns: number;
  status: string;
  error?: string | null;
  createdAt: string;
  messages: TranscriptMessage[];
}

const CUSTOM_AGENT_VALUE = '__custom__';

function resolveAgentValue(gatewayId: string, agent: GatewayAgentSummary): string {
  if (agent.runtimeAgentId?.trim()) {
    return agent.runtimeAgentId.trim();
  }

  if (agent.id && !agent.id.startsWith(`${gatewayId}:`)) {
    return agent.id;
  }

  return agent.name;
}

export function CrossGatewayChatPanel({
  gateways,
  onRefresh,
}: CrossGatewayChatPanelProps) {
  const availableGateways = useMemo(
    () => gateways.filter((gateway) => gateway.url && gateway.hasOpenClawToken),
    [gateways]
  );

  const [fromGatewayId, setFromGatewayId] = useState('');
  const [toGatewayId, setToGatewayId] = useState('');
  const [fromAgentId, setFromAgentId] = useState('main');
  const [toAgentId, setToAgentId] = useState('main');
  const [fromAgentMode, setFromAgentMode] = useState('main');
  const [toAgentMode, setToAgentMode] = useState('main');
  const [turns, setTurns] = useState(2);
  const [prompt, setPrompt] = useState('请互相打个招呼，并简单介绍各自擅长做什么。');
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [sessions, setSessions] = useState<SavedChatSession[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [refreshingGatewayId, setRefreshingGatewayId] = useState('');

  useEffect(() => {
    const fetchHistory = async () => {
      setLoadingHistory(true);

      try {
        const response = await fetch('/api/gateways/chat?limit=6');
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || '加载历史记录失败');
        }

        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        setNotice(
          data.persistenceAvailable === false
            ? '当前进程还没挂上新的 Prisma 模型，对话可用，但历史记录暂时不可写。重启 dev server 后通常会恢复。'
            : ''
        );
      } catch (err) {
        console.error('Failed to load cross-gateway chat history:', err);
      } finally {
        setLoadingHistory(false);
      }
    };

    fetchHistory();
  }, []);

  const canRun =
    !!fromGatewayId &&
    !!toGatewayId &&
    fromGatewayId !== toGatewayId &&
    !!prompt.trim() &&
    !!fromAgentId.trim() &&
    !!toAgentId.trim();

  const fromGateway = availableGateways.find((gateway) => gateway.id === fromGatewayId);
  const toGateway = availableGateways.find((gateway) => gateway.id === toGatewayId);

  const fromAgentOptions = useMemo(() => {
    const agents = fromGateway?.agents || [];
    const mapped = agents.map((agent) => ({
      value: resolveAgentValue(fromGateway!.id, agent),
      label: `${agent.name} (${resolveAgentValue(fromGateway!.id, agent)})${agent.type ? ` / ${agent.type}` : ''}`,
    }));

    return [
      { value: 'main', label: 'main' },
      ...mapped.filter((item, index, list) => list.findIndex((entry) => entry.value === item.value) === index && item.value !== 'main'),
    ];
  }, [fromGateway]);

  const toAgentOptions = useMemo(() => {
    const agents = toGateway?.agents || [];
    const mapped = agents.map((agent) => ({
      value: resolveAgentValue(toGateway!.id, agent),
      label: `${agent.name} (${resolveAgentValue(toGateway!.id, agent)})${agent.type ? ` / ${agent.type}` : ''}`,
    }));

    return [
      { value: 'main', label: 'main' },
      ...mapped.filter((item, index, list) => list.findIndex((entry) => entry.value === item.value) === index && item.value !== 'main'),
    ];
  }, [toGateway]);

  useEffect(() => {
    if (!fromGateway) {
      return;
    }

    if (!fromAgentOptions.some((option) => option.value === fromAgentId)) {
      setFromAgentId('main');
      setFromAgentMode('main');
    } else if (fromAgentId !== CUSTOM_AGENT_VALUE) {
      setFromAgentMode(fromAgentId);
    }
  }, [fromGateway, fromAgentId, fromAgentOptions]);

  useEffect(() => {
    if (!toGateway) {
      return;
    }

    if (!toAgentOptions.some((option) => option.value === toAgentId)) {
      setToAgentId('main');
      setToAgentMode('main');
    } else if (toAgentId !== CUSTOM_AGENT_VALUE) {
      setToAgentMode(toAgentId);
    }
  }, [toGateway, toAgentId, toAgentOptions]);

  const getGatewayLabel = (gatewayId: string | null | undefined) => {
    if (!gatewayId) {
      return 'user';
    }

    const gateway = gateways.find((item) => item.id === gatewayId);
    return gateway ? `${gateway.name} (${gateway.id})` : gatewayId;
  };

  const handleRun = async () => {
    if (!canRun) {
      setError('请选择两个不同的 Gateway，并填写 agentId 与初始 prompt');
      return;
    }

    setRunning(true);
    setError('');
    setNotice('');

    try {
      const response = await fetch('/api/gateways/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fromGatewayId,
          toGatewayId,
          fromAgentId: fromAgentId.trim(),
          toAgentId: toAgentId.trim(),
          prompt: prompt.trim(),
          turns,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '跨 Gateway 对话失败');
      }

      setMessages(Array.isArray(data.messages) ? data.messages : []);
      if (data.persistenceAvailable === false) {
        setNotice('本次对话已完成，但历史记录暂时没有写入数据库。重启 dev server 后再试一次即可。');
      }
      setSessions((prev) => {
        if (data.persistenceAvailable === false) {
          return prev;
        }

        const nextSession: SavedChatSession = {
          id: data.sessionId,
          fromGatewayId,
          toGatewayId,
          fromAgentId: fromAgentId.trim(),
          toAgentId: toAgentId.trim(),
          prompt: prompt.trim(),
          turns,
          status: 'completed',
          createdAt: new Date().toISOString(),
          messages: Array.isArray(data.messages) ? data.messages : [],
        };

        return [nextSession, ...prev].slice(0, 6);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '跨 Gateway 对话失败');
      setMessages([]);
    } finally {
      setRunning(false);
    }
  };

  const refreshGatewayAgents = async (gatewayId: string) => {
    if (!gatewayId) {
      return;
    }

    setRefreshingGatewayId(gatewayId);
    setError('');
    setNotice('');

    try {
      const response = await fetch(`/api/gateways/${gatewayId}/agents/refresh`, {
        method: 'POST',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '刷新 Gateway agents 失败');
      }

      setNotice(
        `${getGatewayLabel(gatewayId)} 已刷新 ${data.count ?? 0} 个 agents。`
      );
      await onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新 Gateway agents 失败');
    } finally {
      setRefreshingGatewayId('');
    }
  };

  if (availableGateways.length < 2) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
        至少需要 2 个已配置 OpenClaw token 的 Gateway，才能开始跨 Gateway 对话。
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Cross Gateway Chat</h2>
          <p className="mt-1 text-sm text-gray-600">
            先由 Gateway A 回答，再把结果交给 Gateway B，返回一段可见 transcript。
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700">起始 Gateway</label>
          <div className="mt-2 flex gap-2">
            <select
              value={fromGatewayId}
              onChange={(e) => setFromGatewayId(e.target.value)}
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="">请选择 Gateway A</option>
              {availableGateways.map((gateway) => (
                <option key={gateway.id} value={gateway.id}>
                  {gateway.name} ({gateway.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => refreshGatewayAgents(fromGatewayId)}
              disabled={!fromGatewayId || !!refreshingGatewayId}
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshingGatewayId === fromGatewayId ? '刷新中...' : '刷新 Agents'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">目标 Gateway</label>
          <div className="mt-2 flex gap-2">
            <select
              value={toGatewayId}
              onChange={(e) => setToGatewayId(e.target.value)}
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="">请选择 Gateway B</option>
              {availableGateways.map((gateway) => (
                <option key={gateway.id} value={gateway.id}>
                  {gateway.name} ({gateway.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => refreshGatewayAgents(toGatewayId)}
              disabled={!toGatewayId || !!refreshingGatewayId}
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshingGatewayId === toGatewayId ? '刷新中...' : '刷新 Agents'}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div>
          <label className="block text-sm font-medium text-gray-700">Gateway A Agent ID</label>
          <select
            value={fromAgentMode}
            onChange={(e) => {
              const value = e.target.value;
              setFromAgentMode(value);
              if (value !== CUSTOM_AGENT_VALUE) {
                setFromAgentId(value);
              }
            }}
            className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            {fromAgentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_AGENT_VALUE}>手动输入其他 agentId</option>
          </select>
          {fromAgentMode === CUSTOM_AGENT_VALUE ? (
            <input
              value={fromAgentId}
              onChange={(e) => setFromAgentId(e.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="例如：codex / claude / researcher"
            />
          ) : null}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Gateway B Agent ID</label>
          <select
            value={toAgentMode}
            onChange={(e) => {
              const value = e.target.value;
              setToAgentMode(value);
              if (value !== CUSTOM_AGENT_VALUE) {
                setToAgentId(value);
              }
            }}
            className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            {toAgentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_AGENT_VALUE}>手动输入其他 agentId</option>
          </select>
          {toAgentMode === CUSTOM_AGENT_VALUE ? (
            <input
              value={toAgentId}
              onChange={(e) => setToAgentId(e.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="例如：coder / researcher / acp-agent"
            />
          ) : null}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">对话轮次</label>
          <select
            value={String(turns)}
            onChange={(e) => setTurns(e.target.value === '1' ? 1 : 2)}
            className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <option value="1">1 轮: User -&gt; A -&gt; B</option>
            <option value="2">2 轮: User -&gt; A -&gt; B -&gt; A</option>
          </select>
        </div>
      </div>

      <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700">初始 Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          placeholder="例如：请围绕多网关协作做一个简短讨论。"
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          现在支持单轮和双轮链路，也支持给两侧分别指定 `agentId`。
        </p>
        <button
          onClick={handleRun}
          disabled={!canRun || running}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? '对话中...' : '开始跨 Gateway 对话'}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {notice}
        </div>
      ) : null}

      <div className="mt-5 rounded-2xl border border-gray-200 bg-slate-50 p-4">
        <div className="mb-3 text-sm font-medium text-gray-700">Transcript</div>
        {messages.length === 0 ? (
          <div className="text-sm text-gray-500">
            还没有 transcript。选择两个 Gateway 后开始一次对话即可看到结果。
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message, index) => (
              <div
                key={`${message.speaker}-${index}`}
                className="rounded-xl border border-gray-200 bg-white p-3"
              >
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  {getGatewayLabel(message.gatewayId)}
                  {message.agentId ? ` / ${message.agentId}` : ''}
                </div>
                <div className="whitespace-pre-wrap text-sm text-gray-800">
                  {message.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-gray-700">Recent Sessions</div>
          <div className="text-xs text-gray-500">
            {loadingHistory ? '加载中...' : `最近 ${sessions.length} 条`}
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="text-sm text-gray-500">
            还没有历史记录。跑一次跨 Gateway 对话后，这里会显示最近 transcript。
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="rounded-xl border border-gray-200 bg-slate-50 p-3"
              >
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div className="text-sm font-medium text-gray-800">
                    {getGatewayLabel(session.fromGatewayId)} -&gt; {getGatewayLabel(session.toGatewayId)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {session.turns} 轮 / {session.status}
                  </div>
                </div>
                <div className="mt-2 text-sm text-gray-600">{session.prompt}</div>
                <div className="mt-3 space-y-2">
                  {session.messages.map((message, index) => (
                    <div key={`${session.id}-${index}`} className="rounded-lg bg-white px-3 py-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        {getGatewayLabel(message.gatewayId)}
                        {message.agentId ? ` / ${message.agentId}` : ''}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-sm text-gray-800">
                        {message.text}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
