'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryInventory, HistoryRow } from '@/lib/session-history/types';
type Listing = HistoryInventory & { cleanup: { enabled: boolean; reason?: string }; total: number; page: number; summary: { count: number; bytes: number; eligible: number; eligibleBytes: number; unknown: number } };
type Receipt = { id: string; state: string; expiresAt: number; bytes: number; deletedBytes: number;
  items: Array<{ row: HistoryRow; status: string; error?: string }>; excluded: Array<{ key: string; reasons: string[] }> };
const size = (value: number | null) => value === null ? '未知' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(2)} MiB`;
const states = { retained: '保留期内', protected: '受保护 / 只读', eligible: '可预览清理', unknown: '状态未知' };
const operationStates: Record<string, string> = { preview: '待确认', executing: '执行中', completed: '已完成', needs_review: '待核对' };
const itemStates: Record<string, string> = { pending: '待执行', deleting: '清理中', deleted: '已删除', failed: '失败' };
const button = 'rounded border px-3 py-2 text-sm disabled:opacity-40';
export default function SessionHistoryPage() {
  const [listing, setListing] = useState<Listing>();
  const generation = useRef(0);
  const [harness, setHarness] = useState(''), [state, setState] = useState(''), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [receipt, setReceipt] = useState<Receipt>();
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/session-history?${new URLSearchParams({ harness, state, page: String(page), ...(refresh ? { refresh: '1' } : {}) })}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取失败');
      if (current === generation.current) { setListing(data); setSelected([]); }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : '读取失败'); }
    finally { if (current === generation.current) setBusy(false); }
  }, [harness, state, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = sessionStorage.getItem('ap-history-operation');
    if (id) fetch(`/api/admin/session-history?operation=${encodeURIComponent(id)}`).then(async response => {
      if (response.ok) setReceipt(await response.json());
    }).catch(() => {});
  }, []);
  async function action(confirm: boolean) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/session-history', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirm ? { action: 'confirm', operationId: receipt?.id, confirmPermanent: true } : { action: 'preview', keys: selected }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败');
      setReceipt(data); setConfirmed(false); sessionStorage.setItem('ap-history-operation', data.id);
      if (confirm) await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-7xl space-y-6">
    <div><h1 className="text-2xl font-bold">历史会话</h1>
      <p className="mt-2 text-sm text-gray-600">管理本机原生历史。最后活动超过 30 天且不再绑定或使用的会话，才允许管理员预览并确认永久清理。不会自动删除。</p>
      <p className="mt-1 text-sm text-gray-600">Codex / 平台 Pi 已接入清理；确认时需该工具的任务及原生进程均已退出。Kimi / Antigravity 当前只读。平台任务、审批及聊天记录保留。</p></div>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
    {listing && <div className="rounded border bg-white p-4 text-sm">
      <p>已扫描 {listing.summary.count} 个会话 · 已测记录 {size(listing.summary.bytes)} · 可预览 {listing.summary.eligible} 个 / {size(listing.summary.eligibleBytes)} · 未知大小 {listing.summary.unknown} 个</p>
      {!listing.cleanup.enabled && <p className="mt-2 text-amber-700">{listing.cleanup.reason}</p>}
      <p className="mt-1 text-gray-500">采样于 {new Date(listing.sampledAt).toLocaleString()}。字节数为记录文件长度，不等于实际磁盘释放量；不含工具配置、缓存和所有附属索引。</p>
      {listing.truncated && <p className="mt-2 text-red-700">扫描不完整，本次全部禁止清理。请查看下方来源状态。</p>}
    </div>}
    <div className="flex flex-wrap gap-3">
      <select aria-label="工具" className={button} value={harness} onChange={event => { setHarness(event.target.value); setPage(0); }}>
        <option value="">全部工具</option>{['codex', 'kimi-code', 'pi-agent', 'antigravity'].map(value => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="保留状态" className={button} value={state} onChange={event => { setState(event.target.value); setPage(0); }}>
        <option value="">全部状态</option>{Object.entries(states).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
      </select>
      <button className={button} disabled={busy} onClick={() => void load(true)}>重新扫描</button>
      <button className={button} disabled={busy || !listing} onClick={() => setSelected(listing?.rows.filter(row => row.state === 'eligible').map(row => row.key) || [])}>选择本页可清理项</button>
      <button className={button + ' bg-blue-600 text-white'} disabled={busy || !selected.length} onClick={() => void action(false)}>预览清理（{selected.length}）</button>
      {busy && <span role="status" className="self-center text-sm">正在核对…</span>}
    </div>
    {receipt && <section className="space-y-3 rounded border border-amber-400 bg-amber-50 p-4">
      <h2 className="font-semibold">{receipt.state === 'preview' ? '永久清理预览' : '清理回执'} · {operationStates[receipt.state] || receipt.state}</h2>
      <p className="break-all text-xs">操作 ID：{receipt.id}</p>
      <p className="text-sm">固定清单 {receipt.items.length} 条 / {size(receipt.bytes)}；已确认删除 {size(receipt.deletedBytes)}。排除 {receipt.excluded.length} 条。</p>
      <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">{receipt.items.map(item => <li className="break-all" key={item.row.key}>{item.row.harness} · {item.row.nativeId} · {size(item.row.bytes)} · {itemStates[item.status] || item.status}{item.error && <span className="text-red-700">：{item.error}</span>}</li>)}</ul>
      {receipt.excluded.map(item => <p className="break-all text-xs" key={item.key}>已排除 {item.key.slice(0, 12)}：{item.reasons.join('；')}</p>)}
      {receipt.state === 'preview' ? <>
        <p className="text-sm">预览有效至 {new Date(receipt.expiresAt).toLocaleString()}。执行时会再次检查，变化的会话将拒绝清理。</p>
        <label className="block text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 我已核对清单，确认永久删除，原生历史不可恢复。</label>
        <button className={button + ' bg-red-700 text-white'} disabled={busy || !listing?.cleanup.enabled || !confirmed || !receipt.items.length || Date.now() >= receipt.expiresAt} onClick={() => void action(true)}>确认永久清理</button>
      </> : <p className="text-sm">失败或中断不自动重放。若仍显示执行中或清理中，保留操作 ID 供核对，勿手动删除审计文件。</p>}
      <button className={button + ' ml-3'} disabled={busy} onClick={() => { setReceipt(undefined); setConfirmed(false); sessionStorage.removeItem('ap-history-operation'); }}>关闭</button>
    </section>}
    <div className="overflow-x-auto rounded border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-gray-50"><th className="p-3">选择</th><th>工具 / 原生 ID</th><th>项目 / 关联任务</th><th>记录大小</th><th>最后活动</th><th>状态 / 原因</th></tr></thead>
      <tbody>{listing?.rows.map(row => <tr key={row.key} className="border-b align-top">
        <td className="p-3"><input type="checkbox" aria-label={`选择 ${row.nativeId}`} disabled={busy || row.state !== 'eligible'} checked={selected.includes(row.key)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.key] : previous.filter(key => key !== row.key))} /></td>
        <td className="max-w-52 break-all p-3"><strong>{row.harness}</strong><div className="text-xs">{row.nativeId}</div><details className="mt-1 text-xs"><summary>存储位置</summary>{row.location}</details></td>
        <td className="max-w-56 break-all p-3">{row.project || '未提供项目'}{row.references.map(ref => <div key={ref.taskId}><a className="text-blue-700 underline" href={ref.taskId.startsWith('room:') ? `/rooms/${ref.taskId.slice(5)}` : `/tasks/${ref.taskId}`}>{ref.taskName}</a></div>)}{!row.references.length && <p className="text-gray-500">未关联平台</p>}</td>
        <td className="whitespace-nowrap p-3">{size(row.bytes)}<div className="text-xs text-gray-500">{row.fileCount} 个文件</div></td>
        <td className="p-3">{row.lastActivity ? new Date(row.lastActivity).toLocaleString() : '未知'}</td>
        <td className="max-w-64 p-3">{states[row.state]}<p className="mt-1 text-xs text-gray-600">{row.reasons.join('；')}</p></td>
      </tr>)}</tbody></table>{listing && !listing.rows.length && <p className="p-6 text-gray-500">当前筛选没有会话。</p>}</div>
    <div className="flex items-center gap-3 text-sm"><button className={button} disabled={busy || page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页 · 共 {listing?.total ?? 0} 条</span><button className={button} disabled={busy || !listing || (page + 1) * 50 >= listing.total} onClick={() => setPage(page + 1)}>下一页</button></div>
    {listing && <details className="rounded border p-4 text-sm"><summary>扫描范围与未覆盖来源</summary>
      <p className="mt-3">未覆盖：{listing.unsupported.join('、')}。未列出不代表没有历史。</p>
      <ul className="mt-3 space-y-1">{listing.sources.map(source => <li className="break-all" key={source.home}>{source.harness} · {source.home} · {source.status} · {source.count} 条 {source.error}</li>)}</ul>
    </details>}
  </div>;
}
