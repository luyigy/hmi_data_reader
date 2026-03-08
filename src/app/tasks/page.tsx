import Sidebar from "@/components/layout/Sidebar";

const tasks = [
  { id: "task-1", title: "Sync agent registry", status: "running" },
  { id: "task-2", title: "Generate health report", status: "pending" },
  { id: "task-3", title: "Archive resolved incidents", status: "completed" },
];

export default function TasksPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-8">
          <header className="mb-6">
            <p className="text-sm uppercase tracking-widest text-slate-500">Tasks</p>
            <h2 className="mt-2 text-3xl font-semibold">Task Queue</h2>
          </header>
          <div className="rounded-xl border border-slate-200 bg-white">
            <ul className="divide-y divide-slate-200">
              {tasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between p-4">
                  <span className="text-sm font-medium text-slate-800">
                    {task.title}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    {task.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </main>
      </div>
    </div>
  );
}
