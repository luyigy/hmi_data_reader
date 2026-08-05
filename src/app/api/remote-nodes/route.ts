import { NextResponse } from 'next/server';
import { listRemoteNodes } from '@/lib/remote-node-registry';
import { getConnectedNodeCount } from '@/lib/remote-node-ws';

export async function GET() {
  try {
    const nodes = await listRemoteNodes();
    const connectedCount = getConnectedNodeCount();
    return NextResponse.json({ nodes, connectedCount });
  } catch (error) {
    console.error('[RemoteNodes] Error:', error);
    return NextResponse.json({ error: 'Failed to list nodes' }, { status: 500 });
  }
}
