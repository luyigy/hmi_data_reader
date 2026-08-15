'use client';

import { useState } from 'react';

// The async Clipboard API only exists in secure contexts (HTTPS or localhost).
// This platform is usually served over plain HTTP on the LAN, so fall back to
// the legacy execCommand path instead of crashing with
// "Cannot read properties of undefined (reading 'writeText')".
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function PairComputerButton({ collapsed }: { collapsed: boolean }) {
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<'windows' | 'unix' | 'manual' | null>(null);

  const create = async () => {
    setLoading(true);
    setError('');
    setCopied(null);
    try {
      const response = await fetch('/api/pairing-tickets', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '创建配对票据失败');
      setCommand(`${window.location.origin}/runner.js | node - --pairing-token=${result.token}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建配对票据失败');
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text: string, target: 'windows' | 'unix') => {
    const ok = await copyText(text);
    setCopied(ok ? target : 'manual');
    if (ok) setTimeout(() => setCopied(null), 2500);
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
                <p className="mt-2 text-sm text-slate-600">在目标电脑打开终端并运行以下命令，无需先 cd。需已安装 Node.js；票据 10 分钟内有效且只能使用一次。</p>
                <p className="mt-4 text-xs font-medium text-slate-600">Windows PowerShell / CMD</p>
                <pre className="mt-1 select-text overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100"><code>curl.exe -fsSL {command}</code></pre>
                <p className="mt-4 text-xs font-medium text-slate-600">macOS / Linux</p>
                <pre className="mt-1 select-text overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100"><code>curl -fsSL {command}</code></pre>
                <button onClick={() => void copy(`curl.exe -fsSL ${command}`, 'windows')} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
                  {copied === 'windows' ? '已复制 ✓' : '复制 Windows 命令'}
                </button>
                <button onClick={() => void copy(`curl -fsSL ${command}`, 'unix')} className="ml-3 mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
                  {copied === 'unix' ? '已复制 ✓' : '复制 macOS/Linux 命令'}
                </button>
                {copied === 'manual' && (
                  <span className="ml-3 text-xs text-amber-600">浏览器禁止了自动复制，请手动选中上方命令复制。</span>
                )}
              </>
            )}
            <button onClick={() => { setCommand(''); setError(''); setCopied(null); }} className="ml-3 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">关闭</button>
          </div>
        </div>
      )}
    </>
  );
}
