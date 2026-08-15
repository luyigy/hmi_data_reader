'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  displayName: string | null;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '获取用户失败');
    setUsers(data.users);
  }, []);

  useEffect(() => {
    loadUsers().catch((cause) => setError(cause instanceof Error ? cause.message : '获取用户失败'));
  }, [loadUsers]);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError('');
    const form = new FormData(formElement);
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(form)),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error || '创建用户失败');
    formElement.reset();
    await loadUsers();
  };

  const resetPassword = async (user: User) => {
    const password = window.prompt(`为 ${user.username} 设置新密码（至少 8 位）`);
    if (!password) return;
    const response = await fetch(`/api/admin/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) setError(data.error || '重置密码失败');
  };

  const removeUser = async (user: User) => {
    if (!window.confirm(`确认删除用户 ${user.username}？其资源将保留为无主资源。`)) return;
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) return setError(data.error || '删除用户失败');
    await loadUsers();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">用户管理</h1>
        <p className="mt-1 text-sm text-gray-500">创建账号并将初始密码安全地分发给成员。</p>
      </div>

      <form onSubmit={createUser} className="grid gap-4 rounded-xl bg-white p-6 shadow-sm md:grid-cols-4">
        <input name="username" required minLength={3} maxLength={64} pattern="[a-zA-Z0-9._-]+" placeholder="用户名" className="rounded-lg border px-3 py-2" />
        <input name="displayName" maxLength={100} placeholder="显示名（可选）" className="rounded-lg border px-3 py-2" />
        <input name="password" type="password" required minLength={8} placeholder="初始密码（至少 8 位）" className="rounded-lg border px-3 py-2" />
        <button disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
          {busy ? '创建中…' : '创建用户'}
        </button>
      </form>

      {error ? <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr><th className="px-5 py-3">用户</th><th className="px-5 py-3">角色</th><th className="px-5 py-3 text-right">操作</th></tr>
          </thead>
          <tbody className="divide-y">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-5 py-4"><div className="font-medium text-gray-900">{user.displayName || user.username}</div><div className="text-gray-500">{user.username}</div></td>
                <td className="px-5 py-4">{user.role === 'admin' ? '管理员' : '用户'}</td>
                <td className="space-x-3 px-5 py-4 text-right">
                  <button onClick={() => resetPassword(user)} className="text-blue-600 hover:underline">重置密码</button>
                  <button onClick={() => removeUser(user)} className="text-red-600 hover:underline">删除</button>
                </td>
              </tr>
            ))}
            {!users.length ? <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-500">暂无数据库用户</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
