'use client';

import { LiveRoomDetailsPanel } from './LiveRoomDetailsPanel';
import { LiveRoomProvider } from './live-room-context';
import { LiveRoomRoomsPanel } from './LiveRoomRoomsPanel';
import { LiveRoomThread } from './LiveRoomThread';
import { useLiveRoomController } from './use-live-room-controller';

export function LiveRoomWorkspace({
  initialRoomId,
  basePath = '/workspaces',
}: {
  initialRoomId?: string;
  basePath?: string;
}) {
  const controller = useLiveRoomController({ initialRoomId, basePath });

  return (
    <LiveRoomProvider value={controller}>
      <div className={`grid h-[calc(100vh-4rem)] min-h-[780px] overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)] ${controller.layoutClass}`}>
        <LiveRoomRoomsPanel />
        <LiveRoomThread />
        <LiveRoomDetailsPanel />
      </div>
    </LiveRoomProvider>
  );
}
