import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { configureNodeWorkspace, handleNodeConnection } from '../src/lib/remote-node-ws';

type Listener = (event: { data?: Buffer }) => void;

class FakeWebSocket {
  public readonly readyState = 1;
  private readonly listeners = new Map<string, Listener[]>();
  public readonly sent: string[] = [];
  public readonly closed: Array<[number, string]> = [];

  addEventListener(type: string, listener: Listener, _options?: { once?: boolean }): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  emit(type: string, data?: Buffer): void {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
    this.emit('close');
  }
}

async function main() {
  const nodeName = `ws-test-${crypto.randomBytes(3).toString('hex')}`;
  const secret = crypto.randomBytes(16).toString('hex');
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  await prisma.remoteNode.create({
    data: { name: nodeName, host: 'unconnected', secretHash, status: 'offline' },
  });

  try {
    const ws = new FakeWebSocket();
    const req = {
      url: `/?node=${nodeName}`,
      headers: { host: 'localhost', authorization: `Bearer ${secret}` },
      socket: { remoteAddress: '127.0.0.1' },
    };

    // Runners fire `hello` immediately on 'open', i.e. while handleNodeConnection
    // is still awaiting verifyNodeSecret/registerNode. This frame used to be
    // dropped because the message listener was attached after those awaits.
    const handled = handleNodeConnection(ws as never, req as never);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'hello', node: nodeName, harnesses: ['pi-agent'], workspace: '/tmp/ws-test',
    })));
    await handled;

    assert.ok(ws.sent.some((raw) => raw.includes('"type":"welcome"')), 'welcome frame sent');

    const configured = configureNodeWorkspace(nodeName, '/tmp/new-workspace');
    const request = JSON.parse(ws.sent.at(-1) || '{}') as { type?: string; requestId?: string };
    assert.equal(request.type, 'set_workspace');
    assert.equal(typeof request.requestId, 'string');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'workspace_result', requestId: request.requestId, success: true, workspace: '/tmp/new-workspace',
    })));
    assert.equal(await configured, '/tmp/new-workspace');

    // The early hello must have reached the registry despite the setup awaits.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const node = await prisma.remoteNode.findUnique({ where: { name: nodeName } });
      const metadata = node?.metadata ? JSON.parse(node.metadata) : {};
      if (metadata.harnesses) {
        assert.deepEqual(metadata.harnesses, ['pi-agent']);
        assert.equal(metadata.workspace, '/tmp/ws-test');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.notEqual(attempt, 19, 'hello metadata from the early frame never persisted');
    }

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat' })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(ws.sent.some((raw) => raw.includes('"type":"heartbeat_ack"')), 'heartbeat acked');

    // Invalid credentials and missing node/secret still close with the gate codes.
    const badSecret = new FakeWebSocket();
    await handleNodeConnection(badSecret as never, {
      url: `/?node=${nodeName}`, headers: { host: 'localhost', authorization: 'Bearer nope' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);
    assert.deepEqual(badSecret.closed[0], [4003, 'Invalid credentials']);

    const noAuth = new FakeWebSocket();
    await handleNodeConnection(noAuth as never, {
      url: `/?node=${nodeName}`, headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);
    assert.deepEqual(noAuth.closed[0], [4001, 'Missing node name or secret']);
  } finally {
    await prisma.remoteNode.deleteMany({ where: { name: nodeName } });
  }

  console.log('remote node ws tests passed');
}

void main();
