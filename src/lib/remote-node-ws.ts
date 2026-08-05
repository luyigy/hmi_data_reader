import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { verifyNodeSecret, registerNode, markNodeOffline } from './remote-node-registry';

interface NodeSocket {
  ws: WebSocket;
  nodeName: string;
  connectedAt: Date;
}

const connectedNodes = new Map<string, NodeSocket>();

/** Handle a WebSocket upgrade request from a remote node */
export async function handleNodeConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const nodeName = url.searchParams.get('node')?.trim();
  const secret = url.searchParams.get('secret')?.trim();

  if (!nodeName || !secret) {
    ws.close(4001, 'Missing node name or secret');
    return;
  }

  const valid = await verifyNodeSecret(nodeName, secret);
  if (!valid) {
    ws.close(4003, 'Invalid credentials');
    return;
  }

  const host = req.socket.remoteAddress || 'unknown';
  const node = await registerNode(nodeName, host, secret);

  connectedNodes.set(nodeName, { ws, nodeName, connectedAt: new Date() });

  console.log(`[RemoteNode] ${nodeName} connected from ${host}`);

  ws.addEventListener('message', (event: { data: Buffer }) => {
    try {
      const msg = JSON.parse(event.data.toString());
      console.log(`[RemoteNode] ${nodeName} message:`, msg.type);
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener('close', () => {
    connectedNodes.delete(nodeName);
    markNodeOffline(nodeName).catch(() => {});
    console.log(`[RemoteNode] ${nodeName} disconnected`);
  });

  ws.addEventListener('error', () => {
    connectedNodes.delete(nodeName);
    markNodeOffline(nodeName).catch(() => {});
  });

  // Send welcome message
  ws.send(JSON.stringify({ type: 'welcome', nodeId: node.id, nodeName: node.name }));
}

/** Get connected node count */
export function getConnectedNodeCount(): number {
  return connectedNodes.size;
}

/** Check if a specific node is connected */
export function isNodeConnected(nodeName: string): boolean {
  return connectedNodes.has(nodeName);
}

/** Send a message to a specific connected node */
export function sendToNode(nodeName: string, message: unknown): boolean {
  const socket = connectedNodes.get(nodeName);
  if (!socket || socket.ws.readyState !== WebSocket.OPEN) return false;
  socket.ws.send(JSON.stringify(message));
  return true;
}

/** Broadcast to all connected nodes */
export function broadcastToNodes(message: unknown): void {
  const payload = JSON.stringify(message);
  connectedNodes.forEach((socket) => {
    if (socket.ws.readyState === WebSocket.OPEN) {
      socket.ws.send(payload);
    }
  });
}
