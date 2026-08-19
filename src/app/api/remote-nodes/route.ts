import { NextResponse } from 'next/server';
import { getRemoteNodeName, listRemoteNodes, removeOfflineRemoteNode } from '@/lib/remote-node-registry';
import { authenticationErrorResponse, requireCurrentUser } from '@/lib/auth-users';
import { configureRemoteRunnerWorkspace, RemoteRunnerGatewayError } from '@/lib/remote-harness/runner-executor';

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

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const body = await request.json() as { id?: unknown; workspace?: unknown };
    if (typeof body.id !== 'string' || typeof body.workspace !== 'string' || !body.workspace.trim()) {
      return NextResponse.json({ error: 'id and workspace are required' }, { status: 400 });
    }
    const nodeName = await getRemoteNodeName(body.id, user);
    if (!nodeName) return NextResponse.json({ error: 'Remote runner not found' }, { status: 404 });
    const workspace = await configureRemoteRunnerWorkspace(nodeName, body.workspace.trim());
    return NextResponse.json({ workspace });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    if (error instanceof RemoteRunnerGatewayError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const body = await request.json() as { id?: unknown };
    if (typeof body.id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    if (!await removeOfflineRemoteNode(body.id, user)) {
      return NextResponse.json({ error: 'Remote runner is online or not found' }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
