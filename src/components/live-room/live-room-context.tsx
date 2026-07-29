'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { LiveRoomController } from './use-live-room-controller';

const LiveRoomContext = createContext<LiveRoomController | null>(null);

export function LiveRoomProvider({ value, children }: { value: LiveRoomController; children: ReactNode }) {
  return <LiveRoomContext.Provider value={value}>{children}</LiveRoomContext.Provider>;
}

export function useLiveRoomContext() {
  const value = useContext(LiveRoomContext);
  if (!value) throw new Error('LiveRoomProvider is missing');
  return value;
}
