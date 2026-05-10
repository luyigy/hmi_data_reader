import { NextResponse } from 'next/server';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import { listWorkspaceSummaries } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [workspaces, availableAgents] = await Promise.all([
      listWorkspaceSummaries(),
      listLiveRoomCatalogAgents(),
    ]);

    return NextResponse.json({
      workspaces,
      availableAgents,
    });
  } catch (error) {
    console.error('Failed to fetch workspaces:', error);
    return NextResponse.json(
      { error: 'Failed to fetch workspaces' },
      { status: 500 }
    );
  }
}
