'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';

type Proposal = {
  specRef: string;
  nodes: {
    key: string; goal: string; dependsOn: string[];
    acceptance: { mode: 'automatic' | 'agent' | 'human'; checks: string[] };
    executions: { key: string; instructions: string; repository: string; agentSelector: string }[];
  }[];
};
type RunSummary = { id: string; version: number; status: string; createdAt: string };
type RunDetail = {
  id: string; version: number; status: string;
  nodes: {
    key: string; status: string; dependsOn: string[]; acceptance: string;
    evidence?: unknown;
    executions: { id: string; key: string; repository: string; status: string;
      childTaskId?: string | null; commit?: string | null; issueKind?: string | null }[];
  }[];
};

const statusText: Record<string, string> = {
  planned: '等待前置', ready: '已放行', claimed: '执行中', verifying: '验收中',
  awaiting_human: '待人工验收', passed: '已通过', attention: '需处理',
  running: '进行中', completed: '已完成', integrated: '已集成',
};

export default function TaskGraphPage() {
  const parentTaskId = useParams().id as string;
  const [draft, setDraft] = useState('');
  const [version, setVersion] = useState(1);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const proposal = useMemo(() => {
    try { return JSON.parse(draft) as Proposal; } catch { return null; }
  }, [draft]);

  const refresh = useCallback(async (id?: string | null) => {
    const list = await fetch(`/api/task-graph-runs?parentTaskId=${encodeURIComponent(parentTaskId)}`);
    const listData = await list.json();
    if (!list.ok) throw new Error(listData.error || '无法加载任务图');
    setRuns(listData.runs);
    const runId = id || selectedId || listData.runs[0]?.id;
    if (runId) {
      const response = await fetch(`/api/task-graph-runs/${encodeURIComponent(runId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法加载运行详情');
      setSelectedId(runId);
      setDetail(data);
    }
  }, [parentTaskId, selectedId]);

  useEffect(() => { void refresh().catch((error) => setMessage(String(error))); }, [parentTaskId]);

  const start = async () => {
    if (!proposal || !Array.isArray(proposal.nodes) || !proposal.nodes.length) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/task-graph-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ parentTaskId, version, definition: proposal }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '路线启动失败');
      await refresh(data.id);
      setMessage('路线已启动。后续节点按依赖自动放行；人工验收只在预设节点出现。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const decide = async (nodeKey: string, approved: boolean) => {
    if (!detail) return;
    const note = window.prompt(approved ? '填写验收通过依据' : '填写未通过原因');
    if (!note?.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/task-graph-runs/${detail.id}/nodes/${encodeURIComponent(nodeKey)}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '验收提交失败');
      await refresh(detail.id);
      setMessage(`${nodeKey}：${approved ? '已通过' : '未通过'}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <main className="mx-auto max-w-6xl space-y-6 p-6 text-gray-900">
    <div className="flex items-center justify-between">
      <div><h1 className="text-2xl font-semibold">任务路线</h1><p className="mt-1 text-sm text-gray-600">Agent 提出交付、依赖、分工和验收；确认一次后自动接力。</p></div>
      <a href={`/tasks/${parentTaskId}`} className="rounded border px-3 py-2 text-sm">返回父任务</a>
    </div>
    <section className="rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="font-semibold">确认新路线</h2>
      <p className="mt-1 text-sm text-gray-600">粘贴 Agent 提议的任务图 JSON；先检查下方排期，再启动。人工验收人可写 <code>self</code>。</p>
      <textarea aria-label="任务图 JSON" className="mt-3 h-52 w-full rounded border p-3 font-mono text-xs" value={draft}
        onChange={(event) => setDraft(event.target.value)} placeholder="粘贴经 Spec 审查后的任务图 JSON" />
      {proposal?.nodes && Array.isArray(proposal.nodes) ? <div className="mt-3 overflow-x-auto">
        <p className="mb-2 text-sm">Spec：{proposal.specRef}</p>
        <table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="py-2">Slice</th><th>前置</th><th>仓库与 Agent</th><th>验收</th></tr></thead>
          <tbody>{proposal.nodes.map((node) => <tr key={node.key} className="border-b align-top">
            <td className="py-2"><strong>{node.key}</strong><div>{node.goal}</div></td>
            <td>{node.dependsOn.join('、') || '无'}</td>
            <td>{node.executions.map((job) => <div key={job.key}>{job.key} · {job.repository} · {job.agentSelector}</div>)}</td>
            <td>{node.acceptance.mode} · {node.acceptance.checks.join('、')}</td>
          </tr>)}</tbody></table>
        </div> : null}
      <div className="mt-4 flex items-center gap-3"><label className="text-sm">版本 <input type="number" min={1} value={version}
        onChange={(event) => setVersion(Number(event.target.value))} className="ml-2 w-20 rounded border p-2" /></label>
        <button disabled={busy || !proposal?.nodes?.length} onClick={start} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-40">确认并启动整条路线</button></div>
    </section>
    {message && <p role="status" className="rounded border bg-gray-50 p-3 text-sm">{message}</p>}
    <section className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between"><h2 className="font-semibold">运行进度</h2><button onClick={() => void refresh().catch((error) => setMessage(String(error)))} className="text-sm text-indigo-700">刷新</button></div>
      <div className="mt-3 flex gap-2">{runs.map((run) => <button key={run.id} onClick={() => void refresh(run.id)}
        className={`rounded border px-3 py-1 text-sm ${selectedId === run.id ? 'border-indigo-600 bg-indigo-50' : ''}`}>
        V{run.version} · {statusText[run.status] || run.status}</button>)}</div>
      {detail && <div className="mt-4 space-y-3">{detail.nodes.map((node) => <article key={node.key} className="rounded border p-4">
        <div className="flex items-center justify-between"><strong>{node.key} · {statusText[node.status] || node.status}</strong><span className="text-xs text-gray-500">前置：{node.dependsOn.join('、') || '无'}</span></div>
        <div className="mt-2 space-y-1 text-sm">{node.executions.map((job) => <p key={job.id}>{job.key} · {statusText[job.status] || job.status} · {job.repository}
          {job.childTaskId && <> · <a className="text-indigo-700 underline" href={`/tasks/${job.childTaskId}`}>子任务</a></>}
          {job.commit && <> · {job.commit.slice(0, 12)}</>}{job.issueKind && <> · {job.issueKind}</>}</p>)}</div>
        {node.status === 'awaiting_human' && node.acceptance === 'human' && <div className="mt-3 flex gap-2">
          <button disabled={busy} onClick={() => void decide(node.key, true)} className="rounded bg-green-600 px-3 py-1 text-sm text-white">验收通过</button>
          <button disabled={busy} onClick={() => void decide(node.key, false)} className="rounded bg-red-600 px-3 py-1 text-sm text-white">退回处理</button>
        </div>}
      </article>)}</div>}
    </section>
  </main>;
}
