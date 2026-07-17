'use client';

import { useMemo, useState } from 'react';
import {
  buildAcpxPermissionConfigForProfile,
  getPermissionProfileLabel,
} from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';

interface Agent {
  id: string;
  name: string;
  status: string;
  gateway?: {
    id: string;
    name: string;
  } | null;
}

interface AcpxHarnessOption {
  gatewayId: string;
  gatewayName: string;
  executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
  harnessType: string;
  harnessLabel: string;
  agentId?: string;
  agentName?: string;
  runtimeAgentId?: string;
  status: string;
}

interface AcpxParticipantDraft {
  id: string;
  role: string;
  gatewayId: string;
  harnessKey: string;
}

interface TaskFormProps {
  agents: Agent[];
  acpxHarnessOptions: AcpxHarnessOption[];
  onSubmit: (data: {
    name: string;
    description?: string;
    executionMode: 'standard' | 'acpx';
    orchestrationMode?: 'single' | 'staged';
    acpxParticipants?: Array<{
      gatewayId: string;
      gatewayName?: string;
      executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
      harnessType: string;
      harnessLabel?: string;
      role: string;
      agentId?: string;
      agentName?: string;
    }>;
    acpxPermissionConfig?: AcpxPermissionConfig;
    workingDirectory?: string;
    assignedAgentIds?: string[];
  }) => void;
  onClose: () => void;
}

const roleOptions = [
  { value: 'planner', label: '规划者' },
  { value: 'implementer', label: '实现者' },
  { value: 'reviewer', label: '审查者' },
  { value: 'tester', label: '测试者' },
  { value: 'researcher', label: '研究者' },
  { value: 'custom', label: '自定义' },
];

const createDraft = (index: number): AcpxParticipantDraft => ({
  id: `participant-${Date.now()}-${index}`,
  role: index === 0 ? 'implementer' : 'reviewer',
  gatewayId: '',
  harnessKey: '',
});

export default function TaskForm({
  agents,
  acpxHarnessOptions,
  onSubmit,
  onClose,
}: TaskFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [executionMode, setExecutionMode] = useState<'standard' | 'acpx'>('standard');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [permissionProfile, setPermissionProfile] =
    useState<'safe_local' | 'dev_local' | 'full_access'>('safe_local');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [participants, setParticipants] = useState<AcpxParticipantDraft[]>([createDraft(0)]);

  const gatewayOptions = useMemo(
    () =>
      Array.from(
        new Map(acpxHarnessOptions.map((option) => [option.gatewayId, option.gatewayName])).entries()
      ).map(([id, gatewayName]) => ({ id, gatewayName })),
    [acpxHarnessOptions]
  );

  const getHarnessKey = (option: AcpxHarnessOption) =>
    `${option.gatewayId}::${option.harnessType}::${option.agentId || option.agentName || option.harnessLabel}`;

  const resolvedParticipants = participants.map((participant, index) => {
    const option = acpxHarnessOptions.find((item) => getHarnessKey(item) === participant.harnessKey);
    return {
      index,
      participant,
      option,
    };
  });

  const hasLocalParticipant = resolvedParticipants.some(
    ({ option }) => option?.executionBackend === 'platform_local'
  );
  const hasRemoteParticipant = resolvedParticipants.some(
    ({ option }) =>
      option?.executionBackend === 'gateway_openclaw'
      || option?.executionBackend === 'remote_ssh'
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert('请输入任务名称');
      return;
    }

    const acpxParticipants: Array<{
      gatewayId: string;
      gatewayName?: string;
      executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
      harnessType: string;
      harnessLabel?: string;
      role: string;
      agentId?: string;
      agentName?: string;
    }> = [];

    for (const { index, participant, option } of resolvedParticipants) {
      if (executionMode === 'acpx' && !participant.gatewayId) {
        alert(`请为参与方 ${index + 1} 选择网关`);
        return;
      }

      if (executionMode === 'acpx' && !participant.harnessKey) {
        alert(`请为参与方 ${index + 1} 选择 harness`);
        return;
      }

      if (!option) {
        alert(`参与方 ${index + 1} 的 harness 配置无效，请重新选择`);
        return;
      }

      acpxParticipants.push({
        gatewayId: option.gatewayId,
        gatewayName: option.gatewayName,
        executionBackend: option.executionBackend,
        harnessType: option.harnessType,
        harnessLabel: option.harnessLabel,
        role: participant.role,
        agentId: option.agentId,
        agentName: option.agentName,
      });
    }

    if (executionMode === 'acpx' && acpxParticipants.length === 0) {
      alert('请至少选择一个 ACPX 参与方');
      return;
    }

    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      executionMode,
      orchestrationMode:
        executionMode === 'acpx' && acpxParticipants.length > 1 ? 'staged' : 'single',
      acpxParticipants: executionMode === 'acpx' ? acpxParticipants : undefined,
      acpxPermissionConfig:
        executionMode === 'acpx'
          ? buildAcpxPermissionConfigForProfile(permissionProfile, [])
          : undefined,
      workingDirectory:
        executionMode === 'acpx' && hasLocalParticipant && workingDirectory.trim()
          ? workingDirectory.trim()
          : undefined,
      assignedAgentIds:
        executionMode === 'standard' && selectedAgents.length > 0 ? selectedAgents : undefined,
    });
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  const updateParticipant = (id: string, patch: Partial<AcpxParticipantDraft>) => {
    setParticipants((prev) =>
      prev.map((participant) =>
        participant.id === id ? { ...participant, ...patch } : participant
      )
    );
  };

  const addParticipant = () => {
    setParticipants((prev) => [...prev, createDraft(prev.length)]);
  };

  const removeParticipant = (id: string) => {
    setParticipants((prev) => (prev.length > 1 ? prev.filter((participant) => participant.id !== id) : prev));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="mx-4 w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="border-b border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900">新建任务</h2>
        </div>

        <form onSubmit={handleSubmit} className="max-h-[85vh] overflow-y-auto p-6">
          <div className="mb-4">
            <label className="mb-2 block text-sm font-medium text-gray-700">任务名称 *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500"
              placeholder="例如：工程图纸识别"
              autoFocus
            />
          </div>

          <div className="mb-4">
            <label className="mb-2 block text-sm font-medium text-gray-700">执行模式</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setExecutionMode('standard')}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  executionMode === 'standard'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                标准任务
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('acpx')}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  executionMode === 'acpx'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                ACPX 编码任务
              </button>
            </div>
          </div>

          {executionMode === 'acpx' && (
            <>
              <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-700">
                ACPX 使用参与方配置而不是单一 Runner。每一行都明确指定 `执行后端 + 节点 + harness + 角色`，这样你可以区分平台本地 CLI、网关侧 harness 和 Remote SSH harness。
              </div>

              {hasRemoteParticipant && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  远端参与方当前不会自动挂载或同步平台本地工作目录。现在跨节点共享的是任务描述和前序参与方摘要，不是同一份代码工作区。
                </div>
              )}

              <div className="mb-4 space-y-3">
                {participants.map((participant, index) => {
                  const gatewayHarnesses = acpxHarnessOptions.filter(
                    (option) => option.gatewayId === participant.gatewayId
                  );

                  return (
                    <div key={participant.id} className="rounded-lg border border-indigo-200 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-medium text-gray-900">参与方 {index + 1}</div>
                        {participants.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeParticipant(participant.id)}
                            className="text-xs text-red-600 hover:text-red-700"
                          >
                            删除
                          </button>
                        )}
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        <div>
                          <label className="mb-2 block text-sm font-medium text-gray-700">角色</label>
                          <select
                            value={participant.role}
                            onChange={(e) => updateParticipant(participant.id, { role: e.target.value })}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                          >
                            {roleOptions.map((role) => (
                              <option key={role.value} value={role.value}>
                                {role.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-2 block text-sm font-medium text-gray-700">节点</label>
                          <select
                            value={participant.gatewayId}
                            onChange={(e) =>
                              updateParticipant(participant.id, {
                                gatewayId: e.target.value,
                                harnessKey: '',
                              })
                            }
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                          >
                            <option value="">选择节点</option>
                            {gatewayOptions.map((gateway) => (
                              <option key={gateway.id} value={gateway.id}>
                                {gateway.gatewayName}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-2 block text-sm font-medium text-gray-700">Harness</label>
                          <select
                            value={participant.harnessKey}
                            onChange={(e) => updateParticipant(participant.id, { harnessKey: e.target.value })}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                            disabled={!participant.gatewayId}
                          >
                            <option value="">选择 harness</option>
                            {gatewayHarnesses.map((option) => (
                              <option key={getHarnessKey(option)} value={getHarnessKey(option)}>
                                {option.harnessLabel}
                                {option.executionBackend === 'platform_local'
                                  ? ' · 平台本地'
                                  : option.executionBackend === 'remote_ssh'
                                  ? ' · Remote SSH'
                                  : ' · 网关'}
                                {option.agentName ? ` · ${option.agentName}` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={addParticipant}
                  className="rounded-lg border border-dashed border-indigo-300 px-4 py-2 text-sm text-indigo-700 hover:bg-indigo-50"
                >
                  + 添加参与方
                </button>
              </div>

              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">工作目录</label>
                <input
                  type="text"
                  value={workingDirectory}
                  onChange={(e) => setWorkingDirectory(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-indigo-500"
                  placeholder="例如：/data1/code/agent-platform-v2"
                />
                <p className="mt-2 text-xs text-gray-500">
                  仅本地 Codex / Claude 运行会使用这个目录。远端 gateway 不会自动共享这份代码目录。
                </p>
                {workingDirectory.trim() && !hasLocalParticipant ? (
                  <p className="mt-2 text-xs text-amber-700">
                    当前未选择本地 harness，这个工作目录在本次任务里不会生效。
                  </p>
                ) : null}
              </div>

              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">权限</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['safe_local', 'dev_local', 'full_access'] as const).map((profile) => (
                    <button
                      key={profile}
                      type="button"
                      onClick={() => setPermissionProfile(profile)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        permissionProfile === profile
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {getPermissionProfileLabel(profile)}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Antigravity 的 Full Access 会使用 --dangerously-skip-permissions；权限仅对新 run 生效。
                </p>
              </div>
            </>
          )}

          <div className="mb-4">
            <label className="mb-2 block text-sm font-medium text-gray-700">任务描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500"
              placeholder="任务详细描述..."
            />
          </div>

          {executionMode === 'standard' ? (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-gray-700">分配给 Agent</label>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-300 p-2">
                {agents.length === 0 ? (
                  <p className="py-4 text-center text-sm text-gray-500">暂无可用 Agent</p>
                ) : (
                  agents.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAgents.includes(agent.id)}
                        onChange={() => toggleAgent(agent.id)}
                        className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-gray-700">{agent.name}</span>
                          <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
                            {agent.gateway?.name || '未分配网关'}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          agent.status === 'online'
                            ? 'bg-green-100 text-green-800'
                            : agent.status === 'busy'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {agent.status === 'online' ? '在线' : agent.status === 'busy' ? '忙碌' : '离线'}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
            >
              创建任务
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
