'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export const dynamic = 'force-dynamic';

interface RemoteHarnessHostItem {
  id: string;
  label: string;
  host: string;
  port: number;
  sshUser: string;
  authType: string;
  workingDirectory?: string | null;
  status: string;
  viaNetwork: string;
  supportedHarnesses: string[];
  hasPrivateKey: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProbeState {
  loading: boolean;
  output?: string;
  error?: string;
  checkedAt?: string;
}

interface RemoteHarnessHostFormState {
  label: string;
  host: string;
  port: string;
  sshUser: string;
  privateKey: string;
  workingDirectory: string;
  viaNetwork: string;
  supportedHarnesses: string[];
}

const emptyForm = {
  label: '',
  host: '',
  port: '22',
  sshUser: '',
  privateKey: '',
  workingDirectory: '',
  viaNetwork: 'wireguard',
  supportedHarnesses: ['codex'],
};

const toHostFormState = (host: RemoteHarnessHostItem): RemoteHarnessHostFormState => ({
  label: host.label,
  host: host.host,
  port: String(host.port || 22),
  sshUser: host.sshUser,
  privateKey: '',
  workingDirectory: host.workingDirectory || '',
  viaNetwork: host.viaNetwork,
  supportedHarnesses: [...host.supportedHarnesses],
});

export default function RemoteSshToolsPage() {
  const [hosts, setHosts] = useState<RemoteHarnessHostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [probeState, setProbeState] = useState<Record<string, ProbeState>>({});
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RemoteHarnessHostFormState | null>(null);
  const [updatingHostId, setUpdatingHostId] = useState<string | null>(null);
  const [deletingHostId, setDeletingHostId] = useState<string | null>(null);

  const fetchHosts = async () => {
    try {
      const response = await fetch('/api/remote-harness-hosts');
      const data = await response.json();
      setHosts(Array.isArray(data) ? data : []);
    } catch (fetchError) {
      console.error('Failed to fetch remote harness hosts:', fetchError);
      setHosts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchHosts();
  }, []);

  const updateSupportedHarness = (harness: string, checked: boolean) => {
    setForm((current) => ({
      ...current,
      supportedHarnesses: checked
        ? Array.from(new Set([...current.supportedHarnesses, harness]))
        : current.supportedHarnesses.filter((item) => item !== harness),
    }));
  };

  const updateEditSupportedHarness = (harness: string, checked: boolean) => {
    setEditForm((current) => current ? ({
      ...current,
      supportedHarnesses: checked
        ? Array.from(new Set([...current.supportedHarnesses, harness]))
        : current.supportedHarnesses.filter((item) => item !== harness),
    }) : current);
  };

  const handleCreateHost = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setNotice('');
    setError('');

    try {
      const response = await fetch('/api/remote-harness-hosts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          label: form.label,
          host: form.host,
          port: Number(form.port),
          sshUser: form.sshUser,
          privateKey: form.privateKey,
          workingDirectory: form.workingDirectory || undefined,
          viaNetwork: form.viaNetwork,
          supportedHarnesses: form.supportedHarnesses,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      setNotice(`已创建 Remote SSH host：${data.label}`);
      setForm(emptyForm);
      await fetchHosts();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTestHost = async (hostId: string) => {
    setProbeState((current) => ({
      ...current,
      [hostId]: {
        loading: true,
      },
    }));

    try {
      const response = await fetch(`/api/remote-harness-hosts/${hostId}/test`, {
        method: 'POST',
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      setProbeState((current) => ({
        ...current,
        [hostId]: {
          loading: false,
          output: data?.probe?.output || '',
          checkedAt: data?.probe?.checkedAt,
        },
      }));
      await fetchHosts();
    } catch (testError) {
      setProbeState((current) => ({
        ...current,
        [hostId]: {
          loading: false,
          error: testError instanceof Error ? testError.message : '测试失败',
        },
      }));
    }
  };

  const handleStartEditHost = (host: RemoteHarnessHostItem) => {
    setEditingHostId(host.id);
    setEditForm(toHostFormState(host));
    setNotice('');
    setError('');
  };

  const handleSaveHost = async (hostId: string) => {
    if (!editForm) {
      return;
    }

    setUpdatingHostId(hostId);
    setNotice('');
    setError('');

    try {
      const response = await fetch(`/api/remote-harness-hosts/${hostId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          label: editForm.label,
          host: editForm.host,
          port: Number(editForm.port),
          sshUser: editForm.sshUser,
          privateKey: editForm.privateKey || undefined,
          workingDirectory: editForm.workingDirectory || '',
          viaNetwork: editForm.viaNetwork,
          supportedHarnesses: editForm.supportedHarnesses,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      setNotice(`已更新 Remote SSH host：${data.label}`);
      setEditingHostId(null);
      setEditForm(null);
      await fetchHosts();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新失败');
    } finally {
      setUpdatingHostId(null);
    }
  };

  const handleDeleteHost = async (host: RemoteHarnessHostItem) => {
    const confirmed = window.confirm(`确认删除 Remote SSH host "${host.label}" 吗？`);
    if (!confirmed) {
      return;
    }

    setDeletingHostId(host.id);
    setNotice('');
    setError('');

    try {
      const response = await fetch(`/api/remote-harness-hosts/${host.id}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      setNotice(`已删除 Remote SSH host：${host.label}`);
      if (editingHostId === host.id) {
        setEditingHostId(null);
        setEditForm(null);
      }
      await fetchHosts();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setDeletingHostId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
            Remote SSH Tools
          </div>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">Remote Harness Console</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            这里用于配置 WireGuard 后可达的 SSH 主机，并测试远端 `codex` / `claude`
            是否真的可以从平台侧直连执行。
          </p>
        </div>
        <Link
          href="/tasks"
          className="inline-flex items-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          前往 Tasks
        </Link>
      </header>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-slate-900">新增 Remote SSH Host</h2>
          <p className="mt-2 text-sm text-slate-600">
            第一版只支持 SSH key。配置完成后会自动出现在 ACPX harness options 里。
          </p>
          <p className="mt-2 text-sm leading-6 text-amber-700">
            远端 `codex` 请使用非 root SSH 用户。若以 `root` / `sudo` 运行，Codex 会拒绝危险权限跳过参数并直接失败。
          </p>
        </div>

        <form onSubmit={handleCreateHost} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <div className="mb-2 text-sm font-medium text-slate-700">Label</div>
              <input
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                placeholder="例如：WG-Linux-01"
              />
            </label>

            <label className="block">
              <div className="mb-2 text-sm font-medium text-slate-700">Host</div>
              <input
                value={form.host}
                onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                placeholder="例如：10.8.0.12"
              />
            </label>

            <label className="block">
              <div className="mb-2 text-sm font-medium text-slate-700">SSH User</div>
              <input
                value={form.sshUser}
                onChange={(event) => setForm((current) => ({ ...current, sshUser: event.target.value }))}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                placeholder="例如：ubuntu"
              />
            </label>

            <label className="block">
              <div className="mb-2 text-sm font-medium text-slate-700">Port</div>
              <input
                value={form.port}
                onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                placeholder="22"
              />
            </label>

            <label className="block md:col-span-2">
              <div className="mb-2 text-sm font-medium text-slate-700">Working Directory</div>
              <input
                value={form.workingDirectory}
                onChange={(event) =>
                  setForm((current) => ({ ...current, workingDirectory: event.target.value }))
                }
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                placeholder="例如：/data1/code/agent-platform-v2"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-sm font-medium text-slate-700">Network</div>
              <select
                value={form.viaNetwork}
                onChange={(event) => setForm((current) => ({ ...current, viaNetwork: event.target.value }))}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
              >
                <option value="wireguard">wireguard</option>
                <option value="lan">lan</option>
                <option value="public">public</option>
              </select>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium text-slate-700">Supported Harnesses</div>
              <div className="flex flex-wrap gap-3 rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-700">
                {['codex', 'claude'].map((harness) => (
                  <label key={harness} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.supportedHarnesses.includes(harness)}
                      onChange={(event) => updateSupportedHarness(harness, event.target.checked)}
                    />
                    <span>{harness}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <label className="block">
            <div className="mb-2 text-sm font-medium text-slate-700">Private Key</div>
            <textarea
              value={form.privateKey}
              onChange={(event) => setForm((current) => ({ ...current, privateKey: event.target.value }))}
              className="min-h-48 w-full rounded-2xl border border-slate-300 px-4 py-3 font-mono text-xs outline-none transition focus:border-slate-900"
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
            />
          </label>

          {notice ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {notice}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center rounded-2xl bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {saving ? '创建中...' : '创建 Remote SSH Host'}
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-slate-900">已配置 Hosts</h2>
          <p className="mt-2 text-sm text-slate-600">
            测试会通过平台本机 `ssh` 发起连接，并检查远端工作目录与 CLI 可用性。
          </p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
            正在加载 Remote SSH hosts...
          </div>
        ) : hosts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
            还没有 Remote SSH host，先创建一条再测试。
          </div>
        ) : (
          <div className="space-y-4">
            {hosts.map((host) => {
              const probe = probeState[host.id];

              return (
                <div key={host.id} className="rounded-2xl border border-slate-200 p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-900">{host.label}</h3>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          host.status === 'online'
                            ? 'bg-emerald-100 text-emerald-800'
                            : host.status === 'maintenance'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}>
                          {host.status}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-slate-600">
                        {host.sshUser}@{host.host}:{host.port} · {host.viaNetwork}
                      </div>
                      <div className="mt-2 text-sm text-slate-600">
                        working directory: {host.workingDirectory || '(default shell cwd)'}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {host.supportedHarnesses.map((harness) => (
                          <span
                            key={harness}
                            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                          >
                            {harness}
                          </span>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => void handleTestHost(host.id)}
                      disabled={probe?.loading}
                      className="inline-flex items-center rounded-2xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      {probe?.loading ? '测试中...' : '测试连接'}
                    </button>
                    <button
                      onClick={() => handleStartEditHost(host)}
                      className="inline-flex items-center rounded-2xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void handleDeleteHost(host)}
                      disabled={deletingHostId === host.id}
                      className="inline-flex items-center rounded-2xl border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-500 hover:text-rose-800 disabled:cursor-not-allowed disabled:text-rose-300"
                    >
                      {deletingHostId === host.id ? '删除中...' : '删除'}
                    </button>
                  </div>

                  {editingHostId === host.id && editForm ? (
                    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-3 text-sm font-medium text-slate-900">编辑 Remote SSH Host</div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="block">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Label</div>
                          <input
                            value={editForm.label}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, label: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          />
                        </label>
                        <label className="block">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Host</div>
                          <input
                            value={editForm.host}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, host: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          />
                        </label>
                        <label className="block">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">SSH User</div>
                          <input
                            value={editForm.sshUser}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, sshUser: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          />
                        </label>
                        <label className="block">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Port</div>
                          <input
                            value={editForm.port}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, port: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          />
                        </label>
                        <label className="block md:col-span-2">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Working Directory</div>
                          <input
                            value={editForm.workingDirectory}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, workingDirectory: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          />
                        </label>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <label className="block">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Network</div>
                          <select
                            value={editForm.viaNetwork}
                            onChange={(event) =>
                              setEditForm((current) => current ? { ...current, viaNetwork: event.target.value } : current)
                            }
                            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-900"
                          >
                            <option value="wireguard">wireguard</option>
                            <option value="lan">lan</option>
                            <option value="public">public</option>
                          </select>
                        </label>

                        <div>
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Supported Harnesses</div>
                          <div className="flex flex-wrap gap-3 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700">
                            {['codex', 'claude'].map((harness) => (
                              <label key={`${host.id}:${harness}`} className="inline-flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={editForm.supportedHarnesses.includes(harness)}
                                  onChange={(event) => updateEditSupportedHarness(harness, event.target.checked)}
                                />
                                <span>{harness}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>

                      <label className="mt-4 block">
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                          Replace Private Key
                        </div>
                        <textarea
                          value={editForm.privateKey}
                          onChange={(event) =>
                            setEditForm((current) => current ? { ...current, privateKey: event.target.value } : current)
                          }
                          className="min-h-40 w-full rounded-2xl border border-slate-300 px-4 py-3 font-mono text-xs outline-none transition focus:border-slate-900"
                          placeholder="留空表示保留当前 private key"
                        />
                      </label>

                      <div className="mt-4 flex flex-wrap gap-3">
                        <button
                          onClick={() => void handleSaveHost(host.id)}
                          disabled={updatingHostId === host.id}
                          className="inline-flex items-center rounded-2xl bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                        >
                          {updatingHostId === host.id ? '保存中...' : '保存修改'}
                        </button>
                        <button
                          onClick={() => {
                            setEditingHostId(null);
                            setEditForm(null);
                          }}
                          className="inline-flex items-center rounded-2xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {probe?.error ? (
                    <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                      {probe.error}
                    </div>
                  ) : null}

                  {probe?.output ? (
                    <div className="mt-4">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                        Latest Probe {probe.checkedAt ? `· ${new Date(probe.checkedAt).toLocaleString('zh-CN')}` : ''}
                      </div>
                      <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                        {probe.output}
                      </pre>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
