'use client';

import { useEffect, useState } from 'react';

interface Agent {
  id: string;
  agentKey: string;
  originalName: string;  // 来自 gateway 的原始名称（如 "main", "claude-3.5"）
  rawName: string;       // 包含 gateway 的完整名称（如 "OpenClaw - Claude"）
  displayName: string;   // 显示名称（昵称或原始名称）
  userNickname: string | null;
  shortAlias: string | null;
  roleDescription: string | null;
  colorTag: string | null;
  emojiIcon: string | null;
  hostname: string | null;  // 服务器主机名（用于 platform_local agents）
  status: string;
  type: string;
  runtimeAgentId: string | null;
  location: string | null;
  gateway: {
    id: string;
    name: string;
  } | null;
  isPlatformLocal: boolean;  // 是否为平台内置 agent
}

interface AgentIdentityResponse {
  agents: Agent[];
}

const EMOJI_OPTIONS = ['🤖', '🧠', '💻', '🎨', '⚡', '🔮', '🦙', '🌀', '🏗️', '📊', '🔧', '🚀', '⭐', '🎯', '💡'];
const COLOR_OPTIONS = [
  '#4A90E2', // Blue
  '#50E3C2', // Teal
  '#F5A623', // Orange
  '#E056FD', // Purple
  '#FF6B6B', // Red
  '#6BCB77', // Green
  '#FFD93D', // Yellow
  '#4D96FF', // Dark Blue
  '#FF9FF3', // Pink
  '#54A0FF', // Sky Blue
];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    userNickname: string;
    roleDescription: string;
    emojiIcon: string;
    colorTag: string;
  }>({
    userNickname: '',
    roleDescription: '',
    emojiIcon: '🤖',
    colorTag: '#4A90E2',
  });
  const [saveStatus, setSaveStatus] = useState<{ [key: string]: 'saving' | 'saved' | 'error' }>({});

  useEffect(() => {
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data: AgentIdentityResponse = await res.json();
      setAgents(data.agents || []);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
      setAgents([]); // Ensure agents is always an array
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (agent: Agent) => {
    setEditingId(agent.id);
    setEditForm({
      userNickname: agent.userNickname || '',
      roleDescription: agent.roleDescription || '',
      emojiIcon: agent.emojiIcon || '🤖',
      colorTag: agent.colorTag || '#4A90E2',
    });
    setSaveStatus({ ...saveStatus, [agent.id]: undefined });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveAgent = async (agentId: string) => {
    setSaveStatus({ ...saveStatus, [agentId]: 'saving' });

    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });

      if (!res.ok) throw new Error('Failed to save');

      // Update local state
      setAgents(agents.map(agent =>
        agent.id === agentId
          ? {
              ...agent,
              userNickname: editForm.userNickname || null,
              roleDescription: editForm.roleDescription || null,
              emojiIcon: editForm.emojiIcon,
              colorTag: editForm.colorTag,
              displayName: editForm.userNickname || agent.displayName,
            }
          : agent
      ));

      setSaveStatus({ ...saveStatus, [agentId]: 'saved' });
      setTimeout(() => {
        setSaveStatus(prev => ({ ...prev, [agentId]: undefined }));
      }, 2000);

      setEditingId(null);
    } catch (error) {
      console.error('Failed to save agent:', error);
      setSaveStatus({ ...saveStatus, [agentId]: 'error' });
    }
  };

  const getDisplayLabel = (agent: Agent) => {
    return agent.userNickname || agent.displayName;
  };

  const groupedAgents = agents.reduce((acc, agent) => {
    // Platform Local agents are grouped by hostname
    if (agent.isPlatformLocal) {
      const hostname = agent.hostname || 'Local';
      const key = `Platform Local (${hostname})`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(agent);
    } else {
      const key = agent.gateway?.name || 'Unknown';
      if (!acc[key]) acc[key] = [];
      acc[key].push(agent);
    }
    return acc;
  }, {} as Record<string, Agent[]>);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg">Loading agents...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Agent Management</h1>
        <p className="text-gray-600">
          Set nicknames, colors, and icons for your agents. Nicknames make it easier to @mention agents in Live Rooms.
        </p>
      </div>

      {Object.entries(groupedAgents).map(([gatewayName, gatewayAgents]) => (
        <div key={gatewayName} className="mb-8">
          <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">
            {gatewayName}
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {gatewayAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isEditing={editingId === agent.id}
                editForm={editForm}
                setEditForm={setEditForm}
                saveStatus={saveStatus[agent.id]}
                onStartEdit={() => startEdit(agent)}
                onCancelEdit={cancelEdit}
                onSave={() => saveAgent(agent.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  isEditing,
  editForm,
  setEditForm,
  saveStatus,
  onStartEdit,
  onCancelEdit,
  onSave,
}: {
  agent: Agent;
  isEditing: boolean;
  editForm: { userNickname: string; roleDescription: string; emojiIcon: string; colorTag: string };
  setEditForm: (form: { userNickname: string; roleDescription: string; emojiIcon: string; colorTag: string }) => void;
  saveStatus: 'saving' | 'saved' | 'error' | undefined;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
}) {
  return (
    <div
      className="border rounded-lg p-4 bg-white shadow-sm"
      style={{ borderTopColor: agent.colorTag || '#ccc', borderTopWidth: 4 }}
    >
      {isEditing ? (
        <EditMode
          agent={agent}
          editForm={editForm}
          setEditForm={setEditForm}
          saveStatus={saveStatus}
          onCancel={onCancelEdit}
          onSave={onSave}
        />
      ) : (
        <ViewMode
          agent={agent}
          saveStatus={saveStatus}
          onEdit={onStartEdit}
        />
      )}
    </div>
  );
}

function ViewMode({
  agent,
  saveStatus,
  onEdit,
}: {
  agent: Agent;
  saveStatus: 'saving' | 'saved' | 'error' | undefined;
  onEdit: () => void;
}) {
  const displayLabel = agent.userNickname || agent.originalName;
  const mentionLabel = agent.userNickname || agent.shortAlias || agent.originalName;

  return (
    <div>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{agent.emojiIcon || '🤖'}</span>
          <div>
            {agent.userNickname ? (
              <>
                <h3 className="font-semibold text-lg">{agent.userNickname}</h3>
                <p className="text-xs text-gray-400">{agent.originalName}</p>
                <p className="text-[10px] text-gray-300">{agent.rawName}</p>
              </>
            ) : (
              <>
                <h3 className="font-semibold text-lg">{agent.originalName}</h3>
                <p className="text-xs text-gray-400">{agent.rawName}</p>
              </>
            )}
            <p className="text-sm text-gray-500">
              {agent.type}
              {agent.hostname && <span className="text-xs text-gray-400 ml-1">({agent.hostname.split('.')[0]})</span>}
            </p>
          </div>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      {agent.roleDescription && (
        <p className="text-sm text-gray-600 mb-3">{agent.roleDescription}</p>
      )}

      <div className="text-sm text-gray-500 mb-4 space-y-1">
        <div>Mention as: <code className="bg-gray-100 px-2 py-1 rounded">@{mentionLabel}</code></div>
        {!agent.userNickname && (
          <div className="text-xs text-gray-400 italic">Set a nickname for easier @mentions</div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full border-2 border-gray-200"
            style={{ backgroundColor: agent.colorTag || '#ccc' }}
          />
        </div>
        <button
          onClick={onEdit}
          disabled={saveStatus === 'saving'}
          className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Edit'}
        </button>
      </div>
    </div>
  );
}

function EditMode({
  agent,
  editForm,
  setEditForm,
  saveStatus,
  onCancel,
  onSave,
}: {
  agent: Agent;
  editForm: { userNickname: string; roleDescription: string; emojiIcon: string; colorTag: string };
  setEditForm: (form: { userNickname: string; roleDescription: string; emojiIcon: string; colorTag: string }) => void;
  saveStatus: 'saving' | 'saved' | 'error' | undefined;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Original name for reference */}
      <div className="text-xs text-gray-400 bg-gray-50 rounded px-2 py-1">
        <div><strong>Agent:</strong> {agent.originalName}</div>
        <div><strong>From:</strong> {agent.rawName}</div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Nickname (for @mentions)
        </label>
        <input
          type="text"
          value={editForm.userNickname}
          onChange={(e) => setEditForm({ ...editForm, userNickname: e.target.value })}
          placeholder={`e.g., 小C (instead of "${agent.originalName}")`}
          className="w-full px-3 py-2 border rounded-md text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Role Description
        </label>
        <input
          type="text"
          value={editForm.roleDescription}
          onChange={(e) => setEditForm({ ...editForm, roleDescription: e.target.value })}
          placeholder="e.g., 前端开发专家"
          className="w-full px-3 py-2 border rounded-md text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Emoji Icon
        </label>
        <div className="flex flex-wrap gap-2">
          {EMOJI_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setEditForm({ ...editForm, emojiIcon: emoji })}
              className={`w-10 h-10 text-xl rounded-md border-2 transition-all ${
                editForm.emojiIcon === emoji
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Color Tag
        </label>
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setEditForm({ ...editForm, colorTag: color })}
              className={`w-8 h-8 rounded-full border-2 transition-all ${
                editForm.colorTag === color
                  ? 'border-gray-800 scale-110'
                  : 'border-gray-200 hover:scale-105'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={onSave}
          disabled={saveStatus === 'saving'}
          className="flex-1 px-3 py-2 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
        >
          {saveStatus === 'saving' ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          disabled={saveStatus === 'saving'}
          className="px-3 py-2 text-sm border rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {saveStatus === 'error' && (
        <p className="text-sm text-red-500">Failed to save. Please try again.</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    online: { bg: 'bg-green-100', text: 'text-green-700', label: '🟢 Online' },
    offline: { bg: 'bg-gray-100', text: 'text-gray-700', label: '⚫ Offline' },
    busy: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: '🟡 Busy' },
    error: { bg: 'bg-red-100', text: 'text-red-700', label: '🔴 Error' },
  };

  const config = statusConfig[status] || statusConfig.offline;

  return (
    <span className={`px-2 py-1 text-xs rounded-full ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
}
