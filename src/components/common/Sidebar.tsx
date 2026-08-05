'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

const menuItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/workspaces', label: 'Workspaces', icon: '🧠' },
  { href: '/chat', label: 'Chat Room', icon: '💬' },
  { href: '/gateway-tools', label: 'Gateway Tools', icon: '🛠️' },
  { href: '/remote-ssh-tools', label: 'Remote SSH', icon: '🧷' },
  { href: '/tasks', label: '任务', icon: '📋' },
  { href: '/workflow', label: 'Workflow', icon: '🧭' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Hide sidebar on login page
  if (pathname === '/login') return null;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setIsCollapsed(window.localStorage.getItem('app-sidebar-collapsed') === 'true');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('app-sidebar-collapsed', String(isCollapsed));
  }, [isCollapsed]);

  // Redirect to login if not authenticated and not loading
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <aside className="flex h-screen w-20 shrink-0 flex-col items-center justify-center bg-gray-900 text-white">
        <div className="text-sm text-gray-400">加载中...</div>
      </aside>
    );
  }

  if (!user) return null;

  return (
    <aside className={`flex h-screen shrink-0 flex-col bg-gray-900 text-white transition-[width] duration-200 ${
      isCollapsed ? 'w-20' : 'w-64'
    }`}>
      <div className={`flex items-start ${isCollapsed ? 'justify-center px-2 py-6' : 'justify-between p-6'}`}>
        {isCollapsed ? (
          <div className="text-xl font-bold">AP</div>
        ) : (
          <div>
            <h1 className="text-xl font-bold">Agent Platform</h1>
            <p className="mt-1 text-sm text-gray-400">v2.0</p>
          </div>
        )}
        <button
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-full border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
          title={isCollapsed ? '展开导航' : '收起导航'}
        >
          {isCollapsed ? '>' : '<'}
        </button>
      </div>
      
      <nav className="mt-6 flex-1 overflow-y-auto pb-6">
        {menuItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-6'} py-3 transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
              title={item.label}
            >
              <span className={isCollapsed ? '' : 'mr-3'}>{item.icon}</span>
              {!isCollapsed ? <span>{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>
      
      <div className={`border-t border-gray-800 ${isCollapsed ? 'p-3 text-center' : 'p-4'}`}>
        {user && !isCollapsed && (
          <div className="mb-3 text-sm text-gray-400">
            <div className="font-medium text-gray-200">{user.displayName || user.username}</div>
            <div className="text-xs text-gray-500">{user.role === 'admin' ? '管理员' : '用户'}</div>
          </div>
        )}
        <button
          onClick={() => logout()}
          className={`w-full rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-400 transition-colors hover:bg-gray-700 hover:text-white`}
          title="退出登录"
        >
          {isCollapsed ? '🚪' : '退出登录'}
        </button>
      </div>
    </aside>
  );
}
