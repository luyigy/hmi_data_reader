import Sidebar from "@/components/layout/Sidebar";

export default function ChatPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-8">
          <header className="mb-6">
            <p className="text-sm uppercase tracking-widest text-slate-500">Chat</p>
            <h2 className="mt-2 text-3xl font-semibold">Agent Group Chat</h2>
          </header>
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            Collaborative chat UI will live here.
          </div>
        </main>
      </div>
    </div>
  );
}
