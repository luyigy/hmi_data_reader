'use client';

import { useState } from 'react';

export function PairComputerButton({ collapsed }: { collapsed: boolean }) {
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const create = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/pairing-tickets', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '创建配对票据失败');
      setCommand(`curl -fsSL ${window.location.origin}/runner.js | node - --pairing-token=${result.token}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建配对票据失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => void create()}
        disabled={loading}
        className="mb-2 w-full rounded-lg bg-blue-600 px-3 py-2 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        title="接入我的本地电脑"
      >
        {collapsed ? '＋💻' : loading ? '生成中…' : '+ 接入我的本地电脑'}
      </button>
      {(command || error) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="本地电脑配对">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 text-slate-900 shadow-xl">
            <h2 className="text-lg font-semibold">接入我的本地电脑</h2>
            {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : (
              <>
                <p className="mt-2 text-sm text-slate-600">在目标电脑的工作目录运行以下命令。票据 10 分钟内有效且只能使用一次。</p>
                <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100"><code>{command}</code></pre>
                <button onClick={() => void navigator.clipboard.writeText(command)} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">复制命令</button>
              </>
            )}
            <button onClick={() => { setCommand(''); setError(''); }} className="ml-3 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">关闭</button>
          </div>
        </div>
      )}
    </>
  );
}
