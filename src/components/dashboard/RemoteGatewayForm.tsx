'use client';

import { useState } from 'react';

interface RemoteGatewayFormProps {
  onSuccess?: () => void;
}

interface FormData {
  name: string;
  ip: string;
  port: string;
  gatewayId: string;
  token?: string;
  agents: AgentConfig[];
}

interface AgentConfig {
  name: string;
  type: string;
  capabilities: string;
}

export function RemoteGatewayForm({ onSuccess }: RemoteGatewayFormProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [registrationKey, setRegistrationKey] = useState('');

  const [formData, setFormData] = useState<FormData>({
    name: '',
    ip: '',
    port: '8080',
    gatewayId: '',
    token: '',
    agents: [{ name: '', type: 'generic', capabilities: '' }],
  });

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (formData.token) {
        headers['Authorization'] = `Bearer ${formData.token}`;
      }

      const response = await fetch('/api/gateways/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'register',
          gatewayId: formData.gatewayId || `gateway-${Date.now()}`,
          name: formData.name,
          ip: formData.ip,
          port: formData.port,
          agents: formData.agents.map((agent) => ({
            name: agent.name || `${formData.name} Agent`,
            type: agent.type,
            capabilities: agent.capabilities
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean),
            status: 'online',
          })),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || '注册失败');
      }

      setSuccess(true);
      setRegistrationKey(result.gateway?.id || 'unknown');
      
      setTimeout(() => {
        onSuccess?.();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const addAgent = () => {
    setFormData((prev) => ({
      ...prev,
      agents: [...prev.agents, { name: '', type: 'generic', capabilities: '' }],
    }));
  };

  const removeAgent = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      agents: prev.agents.filter((_, i) => i !== index),
    }));
  };

  const updateAgent = (index: number, field: keyof AgentConfig, value: string) => {
    setFormData((prev) => ({
      ...prev,
      agents: prev.agents.map((agent, i) =>
        i === index ? { ...agent, [field]: value } : agent
      ),
    }));
  };

  // Step 1: 选择注册方式
  if (step === 1) {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">注册远程网关</h3>
        <p className="text-sm text-gray-600">
          选择一种方式将其他电脑的 OpenClaw 实例注册到此平台
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          {/* 方式 1: 手动填写 */}
          <button
            onClick={() => setStep(2)}
            className="p-6 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all text-left"
          >
            <div className="flex items-center mb-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </div>
            </div>
            <h4 className="font-semibold text-gray-900 mb-2">手动配置</h4>
            <p className="text-sm text-gray-600">
              填写远程网关的 IP 地址和 Agent 信息，立即注册
            </p>
          </button>

          {/* 方式 2: 自动生成脚本 */}
          <button
            onClick={() => setStep(3)}
            className="p-6 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition-all text-left"
          >
            <div className="flex items-center mb-3">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
            </div>
            <h4 className="font-semibold text-gray-900 mb-2">自动生成脚本</h4>
            <p className="text-sm text-gray-600">
              生成注册脚本和配置，在远程电脑上运行即可自动注册
            </p>
          </button>
        </div>
      </div>
    );
  }

  // Step 2: 手动配置表单
  if (step === 2) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">手动配置远程网关</h3>
          <button
            onClick={() => setStep(1)}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← 返回
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            ✅ 注册成功！网关已添加到列表
          </div>
        )}

        {/* 基本信息 */}
        <div className="space-y-4">
          <h4 className="font-medium text-gray-900">基本信息</h4>
          
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                网关名称 *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="如：Office PC Gateway"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Gateway ID (可选)
              </label>
              <input
                type="text"
                value={formData.gatewayId}
                onChange={(e) => setFormData({ ...formData, gatewayId: e.target.value })}
                placeholder="如：gateway-office-pc"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">留空则自动生成</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                IP 地址 *
              </label>
              <input
                type="text"
                value={formData.ip}
                onChange={(e) => setFormData({ ...formData, ip: e.target.value })}
                placeholder="如：192.168.1.100"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                端口 *
              </label>
              <input
                type="text"
                value={formData.port}
                onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                placeholder="8080"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Gateway Token
              </label>
              <input
                type="text"
                value={formData.token}
                onChange={(e) => setFormData({ ...formData, token: e.target.value })}
                placeholder="可选：用于认证的 token"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">如果网关需要认证，请在此处填写生成的 token</p>
            </div>
          </div>
        </div>

        {/* Agent 配置 */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-gray-900">Agent 配置</h4>
            <button
              onClick={addAgent}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              + 添加 Agent
            </button>
          </div>

          <div className="space-y-3">
            {formData.agents.map((agent, index) => (
              <div key={index} className="p-4 bg-gray-50 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">
                    Agent #{index + 1}
                  </span>
                  {formData.agents.length > 1 && (
                    <button
                      onClick={() => removeAgent(index)}
                      className="text-red-600 hover:text-red-700 text-sm"
                    >
                      删除
                    </button>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <input
                    type="text"
                    value={agent.name}
                    onChange={(e) => updateAgent(index, 'name', e.target.value)}
                    placeholder="Agent 名称"
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />

                  <select
                    value={agent.type}
                    onChange={(e) => updateAgent(index, 'type', e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="coding">Coding</option>
                    <option value="analysis">Analysis</option>
                    <option value="communication">Communication</option>
                    <option value="monitoring">Monitoring</option>
                    <option value="operations">Operations</option>
                    <option value="generic">Generic</option>
                  </select>

                  <input
                    type="text"
                    value={agent.capabilities}
                    onChange={(e) => updateAgent(index, 'capabilities', e.target.value)}
                    placeholder="能力 (逗号分隔，如：python,typescript)"
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 提交按钮 */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t">
          <button
            onClick={() => setStep(1)}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !formData.name || !formData.ip}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '注册中...' : '立即注册'}
          </button>
        </div>
      </div>
    );
  }

  // Step 3: 自动生成脚本
  if (step === 3) {
    const gatewayId = `gateway-${Date.now()}`;
    const scriptContent = `# 远程网关自动注册脚本
  # 在远程电脑上运行此脚本

  # 配置环境变量
  \$env:PLATFORM_URL="http://${formData.ip || '<platform-ip>'}:3000"
  \$env:GATEWAY_ID="${gatewayId}"
  \$env:GATEWAY_NAME="${formData.name || 'Remote Gateway'}"
  \$env:GATEWAY_PORT="8080"
  \$env:GATEWAY_TOKEN="${formData.token || ''}"

  # 运行注册脚本（守护进程模式）
  cd E:\projects\agent-platform-v2
  node scripts/register-remote-gateway.js daemon
  `;

    const copyToClipboard = async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        alert('已复制到剪贴板！');
      } catch {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('已复制到剪贴板！');
      }
    };

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">自动生成注册脚本</h3>
          <button
            onClick={() => setStep(1)}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← 返回
          </button>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            在远程电脑上运行以下脚本，即可自动完成注册并持续心跳
          </p>

          {/* Step 1 */}
          <div className="space-y-2">
            <h4 className="font-medium text-gray-900">Step 1: 复制脚本</h4>
            <div className="relative">
              <pre className="p-4 bg-gray-900 text-green-400 rounded-lg overflow-x-auto text-sm">
                <code>{scriptContent}</code>
              </pre>
              <button
                onClick={() => copyToClipboard(scriptContent)}
                className="absolute top-2 right-2 px-3 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-600 transition-colors"
              >
                复制
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="space-y-2">
            <h4 className="font-medium text-gray-900">Step 2: 在远程电脑上运行</h4>
            <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
              <li>打开 PowerShell（管理员权限）</li>
              <li>粘贴并运行上面的脚本</li>
              <li>脚本会自动注册并持续发送心跳</li>
              <li>按 Ctrl+C 可停止并注销</li>
            </ol>
          </div>

          {/* Step 3 */}
          <div className="space-y-2">
            <h4 className="font-medium text-gray-900">Step 3: 验证注册</h4>
            <p className="text-sm text-gray-700">
              返回 Dashboard 页面，应该能看到新注册的网关和 Agents
            </p>
          </div>

          {/* 高级选项 */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h4 className="font-medium text-blue-900 mb-2">💡 提示</h4>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• 脚本会读取远程电脑的 <code className="bg-blue-100 px-1 rounded">openclaw.json</code> 自动获取 Agent 列表</li>
              <li>• 默认每 30 秒发送一次心跳</li>
              <li>• 跨网络访问需要使用 ngrok 或配置公网 IP</li>
            </ul>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t">
          <button
            onClick={() => setStep(2)}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            返回手动配置
          </button>
          <button
            onClick={() => {
              copyToClipboard(scriptContent);
            }}
            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            复制脚本
          </button>
        </div>
      </div>
    );
  }

  return null;
}
