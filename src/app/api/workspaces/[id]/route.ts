import { NextResponse } from 'next/server';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import { getWorkspaceDetail } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const [workspace, availableAgents] = await Promise.all([
      getWorkspaceDetail(params.id),
      listLiveRoomCatalogAgents(),
    ]);

    if (!workspace) {
      return NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      workspace,
      availableAgents,
    });
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json(
      { error: 'Failed to fetch workspace' },
      { status: 500 }
    );
  }
}
