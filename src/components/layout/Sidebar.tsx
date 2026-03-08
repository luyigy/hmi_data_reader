import Link from "next/link";

const navItems = [
  { label: "Dashboard", href: "/" },
  { label: "Chat", href: "/chat" },
  { label: "Tasks", href: "/tasks" },
];

export default function Sidebar() {
  return (
    <aside className="flex h-full w-64 flex-col gap-6 border-r border-slate-200 bg-white p-6">
      <div>
        <p className="text-sm uppercase tracking-widest text-slate-500">Agent Platform</p>
        <h1 className="text-xl font-semibold text-slate-900">Control Center</h1>
      </div>
      <nav className="flex flex-col gap-2">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto rounded-lg bg-slate-50 p-4 text-xs text-slate-500">
        <p className="font-semibold text-slate-700">Status</p>
        <p className="mt-1">All systems nominal</p>
      </div>
    </aside>
  );
}
