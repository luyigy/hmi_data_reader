import { NextResponse } from 'next/server';
import { listRemoteNodes } from '@/lib/remote-node-registry';
import { authenticationErrorResponse, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const nodes = await listRemoteNodes(await requireCurrentUser(request));
    const connectedCount = nodes.filter((node) => node.status === 'online').length;
    return NextResponse.json({ nodes, connectedCount });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    console.error('[RemoteNodes] Error:', error);
    return NextResponse.json({ error: 'Failed to list nodes' }, { status: 500 });
  }
}
