'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const menuItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/chat', label: 'Chat Room', icon: '💬' },
  { href: '/gateway-tools', label: 'Gateway Tools', icon: '🛠️' },
  { href: '/tasks', label: '任务', icon: '📋' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col bg-gray-900 text-white">
      <div className="p-6">
        <h1 className="text-xl font-bold">Agent Platform</h1>
        <p className="text-sm text-gray-400 mt-1">v2.0</p>
      </div>
      
      <nav className="mt-6 flex-1 overflow-y-auto pb-6">
        {menuItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-6 py-3 transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="mr-3">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      
      <div className="border-t border-gray-800 p-6">
        <div className="text-sm text-gray-400">
          <p>系统状态: <span className="text-green-400">运行中</span></p>
        </div>
      </div>
    </aside>
  );
}
