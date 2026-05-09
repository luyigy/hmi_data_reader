'use client';

import { useState } from 'react';

interface CreateAgentFormProps {
  onSuccess?: () => void;
}

interface FormData {
  name: string;
  type: string;
  location: string;
  capabilities: string;
  gatewayId: string;
}

export function CreateAgentForm({ onSuccess }: CreateAgentFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState<FormData>({
    name: '',
    type: 'generic',
    location: '',
    capabilities: '',
    gatewayId: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const capabilitiesArray = formData.capabilities
        ? formData.capabilities.split(',').map(cap => cap.trim())
        : [];

      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          type: formData.type,
          location: formData.location || undefined,
          capabilities: capabilitiesArray,
          gatewayId: formData.gatewayId || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create agent');
      }

      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">新建 Agent</h2>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
            Agent 名称 *
          </label>
          <input
            type="text"
            id="name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>

        <div>
          <label htmlFor="type" className="block text-sm font-medium text-gray-700 mb-2">
            Agent 类型 *
          </label>
          <select
            id="type"
            value={formData.type}
            onChange={(e) => setFormData({ ...formData, type: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          >
            <option value="generic">通用</option>
            <option value="specialized">专用</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>

        <div>
          <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-2">
            位置
          </label>
          <input
            type="text"
            id="location"
            value={formData.location}
            onChange={(e) => setFormData({ ...formData, location: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="可选"
          />
        </div>

        <div>
          <label htmlFor="capabilities" className="block text-sm font-medium text-gray-700 mb-2">
            能力 (用逗号分隔)
          </label>
          <input
            type="text"
            id="capabilities"
            value={formData.capabilities}
            onChange={(e) => setFormData({ ...formData, capabilities: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="例如: chat, task, analysis"
          />
        </div>

        <div>
          <label htmlFor="gatewayId" className="block text-sm font-medium text-gray-700 mb-2">
            网关 ID
          </label>
          <input
            type="text"
            id="gatewayId"
            value={formData.gatewayId}
            onChange={(e) => setFormData({ ...formData, gatewayId: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="可选，关联到特定网关"
          />
        </div>

        {error && (
          <div className="text-red-600 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '创建中...' : '创建 Agent'}
          </button>
        </div>
      </form>
    </div>
  );
}
