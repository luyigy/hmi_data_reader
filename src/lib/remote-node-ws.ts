import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import {
  markNodeOffline,
  markRemoteNodeMembersOffline,
  markRemoteNodeMembersOnline,
  registerNode,
  verifyNodeSecret,
} from './remote-node-registry';

interface NodeSocket {
  ws: WebSocket;
  nodeName: string;
  connectedAt: Date;
}

export interface RemoteNodeRunRequest {
  runId: string;
  taskId: string;
  cwd: string;
  prompt: string;
  sessionDir?: string;
  continue?: boolean;
}

export interface RemoteNodeRunResult {
  success: boolean;
  output: string;
  filesModified?: string[];
  sessionDir?: string;
  error?: string;
}

interface PendingRun {
  nodeName: string;
  resolve: (result: RemoteNodeRunResult) => void;
  reject: (error: Error) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

const globalState = globalThis as unknown as {
  remoteNodeSockets?: Map<string, NodeSocket>;
  remoteNodeRuns?: Map<string, PendingRun>;
};
const connectedNodes = globalState.remoteNodeSockets ||= new Map<string, NodeSocket>();
const pendingRuns = globalState.remoteNodeRuns ||= new Map<string, PendingRun>();

const failNodeRuns = (nodeName: string, error: Error) => {
  pendingRuns.forEach((run, runId) => {
    if (run.nodeName === nodeName) {
      pendingRuns.delete(runId);
      run.reject(error);
    }
  });
};

/** Handle a WebSocket upgrade request from a remote node. */
export async function handleNodeConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const nodeName = url.searchParams.get('node')?.trim();
  const authorization = req.headers.authorization?.trim() || '';
  const secret = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  // Buffer socket events that fire while the async database setup below is still
  // in flight. Runners send their `hello` immediately on 'open'; attaching the
  // real listeners after the awaits used to drop that frame, so harness/workspace
  // metadata never reached the registry and the node never surfaced in harness options.
  const earlyMessages: string[] = [];
  let earlyClosed = false;
  let onMessage: ((data: string) => void) | null = (data) => earlyMessages.push(data);
  ws.addEventListener('message', (event) => onMessage?.(event.data.toString()));
  ws.addEventListener('close', () => { earlyClosed = true; }, { once: true });

  if (!nodeName || !secret) {
    ws.close(4001, 'Missing node name or secret');
    return;
  }
  if (!await verifyNodeSecret(nodeName, secret)) {
    ws.close(4003, 'Invalid credentials');
    return;
  }

  const host = req.socket.remoteAddress || 'unknown';
  const node = await registerNode(nodeName, host, secret);
  const socket = { ws, nodeName, connectedAt: new Date() };
  connectedNodes.get(nodeName)?.ws.close(4000, 'Replaced by newer connection');
  connectedNodes.set(nodeName, socket);
  await markRemoteNodeMembersOnline(nodeName);

  const handleMessage = (raw: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type === 'hello') {
      const harnesses = Array.isArray(message.harnesses)
        ? message.harnesses.filter((value): value is string => typeof value === 'string')
        : [];
      const workspace = typeof message.workspace === 'string' ? message.workspace : undefined;
      void registerNode(nodeName, host, secret, { harnesses, workspace })
        .catch(() => ws.close(1011, 'Failed to register node metadata'));
      return;
    }
    if (message.type === 'heartbeat') {
      void registerNode(nodeName, host, secret).catch(() => ws.close(1011, 'Heartbeat failed'));
      ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      return;
    }

    const runId = typeof message.runId === 'string' ? message.runId : '';
    const run = pendingRuns.get(runId);
    if (!run || run.nodeName !== nodeName) return;
    if (message.type === 'stdout' && typeof message.data === 'string') run.onStdout?.(message.data);
    if (message.type === 'stderr' && typeof message.data === 'string') run.onStderr?.(message.data);
    if (message.type === 'complete') {
      pendingRuns.delete(runId);
      run.resolve({
        success: message.success === true,
        output: typeof message.output === 'string' ? message.output : '',
        error: typeof message.error === 'string' ? message.error : undefined,
        sessionDir: typeof message.sessionDir === 'string' ? message.sessionDir : undefined,
        filesModified: Array.isArray(message.filesModified)
          ? message.filesModified.filter((value): value is string => typeof value === 'string')
          : [],
      });
    }
  };
  onMessage = handleMessage;
  for (const data of earlyMessages.splice(0)) handleMessage(data);

  const disconnect = () => {
    if (connectedNodes.get(nodeName) !== socket) return;
    connectedNodes.delete(nodeName);
    failNodeRuns(nodeName, new Error(`Remote node disconnected: ${nodeName}`));
    void markNodeOffline(nodeName).catch(() => undefined);
    void markRemoteNodeMembersOffline(nodeName).catch(() => undefined);
  };
  ws.addEventListener('close', disconnect, { once: true });
  ws.addEventListener('error', disconnect, { once: true });
  if (earlyClosed) disconnect();
  ws.send(JSON.stringify({ type: 'welcome', nodeId: node.id, nodeName: node.name }));
}

export const executeOnNode = (
  nodeName: string,
  request: RemoteNodeRunRequest,
  callbacks: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {},
) => new Promise<RemoteNodeRunResult>((resolve, reject) => {
  const socket = connectedNodes.get(nodeName);
  if (!socket || socket.ws.readyState !== WebSocket.OPEN) {
    reject(new Error(`Remote node is offline: ${nodeName}`));
    return;
  }
  if (pendingRuns.has(request.runId)) {
    reject(new Error(`Duplicate remote run id: ${request.runId}`));
    return;
  }
  pendingRuns.set(request.runId, { nodeName, resolve, reject, ...callbacks });
  try {
    socket.ws.send(JSON.stringify({ type: 'run', ...request }));
  } catch (error) {
    pendingRuns.delete(request.runId);
    reject(error instanceof Error ? error : new Error(String(error)));
  }
});

export const cancelNodeRun = (nodeName: string, runId: string) =>
  sendToNode(nodeName, { type: 'cancel', runId });

export const getConnectedNodeCount = () => connectedNodes.size;
export const isNodeConnected = (nodeName: string) => connectedNodes.has(nodeName);

export function sendToNode(nodeName: string, message: unknown): boolean {
  const socket = connectedNodes.get(nodeName);
  if (!socket || socket.ws.readyState !== WebSocket.OPEN) return false;
  socket.ws.send(JSON.stringify(message));
  return true;
}

export function broadcastToNodes(message: unknown): void {
  connectedNodes.forEach((socket) => {
    if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(JSON.stringify(message));
  });
}
