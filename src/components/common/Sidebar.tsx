'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const menuItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/rooms', label: 'Live Rooms', icon: '🧠' },
  { href: '/chat', label: 'Chat Room', icon: '💬' },
  { href: '/gateway-tools', label: 'Gateway Tools', icon: '🛠️' },
  { href: '/tasks', label: '任务', icon: '📋' },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    setIsCollapsed(window.localStorage.getItem('app-sidebar-collapsed') === 'true');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('app-sidebar-collapsed', String(isCollapsed));
  }, [isCollapsed]);

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
      
      <div className={`border-t border-gray-800 ${isCollapsed ? 'p-3 text-center' : 'p-6'}`}>
        <div className="text-sm text-gray-400">
          {isCollapsed ? (
            <span className="text-green-400">●</span>
          ) : (
            <p>系统状态: <span className="text-green-400">运行中</span></p>
          )}
        </div>
      </div>
    </aside>
  );
}
