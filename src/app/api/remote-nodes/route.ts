import { NextResponse } from 'next/server';
import { listRemoteNodes } from '@/lib/remote-node-registry';

export async function GET() {
  try {
    const nodes = await listRemoteNodes();
    const connectedCount = nodes.filter((node) => node.status === 'online').length;
    return NextResponse.json({ nodes, connectedCount });
  } catch (error) {
    console.error('[RemoteNodes] Error:', error);
    return NextResponse.json({ error: 'Failed to list nodes' }, { status: 500 });
  }
}
