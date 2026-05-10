import { LiveRoomWorkspace } from '@/components/live-room/LiveRoomWorkspace';

export const dynamic = 'force-dynamic';

export default function WorkspaceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return <LiveRoomWorkspace initialRoomId={params.id} basePath="/workspaces" />;
}
