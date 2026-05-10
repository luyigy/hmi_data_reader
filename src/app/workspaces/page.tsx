import { LiveRoomWorkspace } from '@/components/live-room/LiveRoomWorkspace';

export const dynamic = 'force-dynamic';

export default function WorkspacesPage() {
  return <LiveRoomWorkspace basePath="/workspaces" />;
}
