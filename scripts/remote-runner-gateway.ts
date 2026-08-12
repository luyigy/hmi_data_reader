import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { cancelNodeRun, executeOnNode, handleNodeConnection } from '@/lib/remote-node-ws';

const host = process.env.REMOTE_RUNNER_GATEWAY_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.REMOTE_RUNNER_GATEWAY_PORT || 3012);
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404).end();
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const nodeName = typeof body.nodeName === 'string' ? body.nodeName : '';
    const runId = typeof body.runId === 'string' ? body.runId : '';
    if (!nodeName || !runId || typeof body.taskId !== 'string' || typeof body.cwd !== 'string' || typeof body.prompt !== 'string') {
      res.writeHead(400).end('Invalid run request');
      return;
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);
    let completed = false;
    res.once('close', () => {
      if (!completed) cancelNodeRun(nodeName, runId);
    });
    const result = await executeOnNode(nodeName, {
      runId,
      taskId: body.taskId,
      cwd: body.cwd,
      prompt: body.prompt,
      sessionDir: typeof body.sessionDir === 'string' ? body.sessionDir : undefined,
      continue: body.continue === true,
    }, {
      onStdout: (data) => write({ type: 'stdout', data }),
      onStderr: (data) => write({ type: 'stderr', data }),
    });
    completed = true;
    write({ type: 'complete', ...result });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(message);
    } else {
      res.end(`${JSON.stringify({ type: 'complete', success: false, error: message })}\n`);
    }
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/runner') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    void handleNodeConnection(ws, req).catch(() => ws.close(1011, 'Node connection failed'));
  });
});

server.listen(port, host, () => console.log(`[RemoteRunnerGateway] listening on ${host}:${port}`));
