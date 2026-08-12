import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { executeRemoteRunnerTask } from '../src/lib/remote-harness/runner-executor';

async function main() {
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.nodeName, 'TX-server');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ type: 'stdout', data: 'working\n' })}\n`);
    res.end(`${JSON.stringify({ type: 'complete', success: true, output: 'done', sessionDir: '/tmp/pi-session', filesModified: ['a.ts'] })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  process.env.REMOTE_RUNNER_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
  const stdout: string[] = [];

  const result = await executeRemoteRunnerTask({
    nodeName: 'TX-server', taskId: 'task-1', cwd: '/repo', prompt: 'do it', timeout: 5000,
    streamCallbacks: { onStdoutChunk: (chunk) => { stdout.push(chunk); } },
  });
  assert.deepEqual(stdout, ['working\n']);
  assert.equal(result.output, 'done');
  assert.equal(result.sessionId, '/tmp/pi-session');
  assert.deepEqual(result.filesModified, ['a.ts']);
  server.close();
  console.log('remote runner executor test passed');
}

void main();
