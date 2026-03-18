'use client';

import { RemoteGatewayForm } from '@/components/dashboard/RemoteGatewayForm';
import { useRouter } from 'next/navigation';

export default function RegisterNodePage() {
  const router = useRouter();

  const handleSuccess = () => {
    // 注册成功后跳转到 Dashboard
    setTimeout(() => {
      router.push('/');
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-3xl mx-auto px-4">
        {/* 返回链接 */}
        <div className="mb-6">
          <button
            onClick={() => router.push('/')}
            className="text-gray-600 hover:text-gray-900 flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            返回 Dashboard
          </button>
        </div>

        {/* 卡片 */}
        <div className="bg-white rounded-xl shadow-lg p-8">
          <RemoteGatewayForm onSuccess={handleSuccess} />
        </div>

        {/* 帮助信息 */}
        <div className="mt-8 p-6 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="font-semibold text-blue-900 mb-2">💡 使用说明</h3>
          <ul className="text-sm text-blue-800 space-y-2">
            <li>• <strong>手动配置</strong>：适合快速注册单个网关</li>
            <li>• <strong>自动生成脚本</strong>：适合批量部署或需要持续心跳的场景</li>
            <li>• 注册后可以在 Dashboard 查看和管理所有 Agents</li>
            <li>• 跨网络访问需要配置公网 IP 或使用 ngrok</li>
          </ul>
        </div>

        {/* 文档链接 */}
        <div className="mt-4 text-center">
          <a
            href="/docs/CROSS_GATEWAY_REGISTRATION.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:text-blue-700 underline"
          >
            查看完整文档 →
          </a>
        </div>
      </div>
    </div>
  );
}
