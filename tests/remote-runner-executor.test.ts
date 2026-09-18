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
    if (body.taskId !== 'task-1') {
      const error = { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429: 已达到 5 小时的使用上限' };
      const events: unknown[] = body.taskId === 'empty' ? [] : [
        { type: 'message_end', message: error },
        { type: 'auto_retry_start', attempt: 1 },
      ];
      if (body.taskId === 'recovered') events.push(
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '恢复成功' }], stopReason: 'stop' } },
        { type: 'auto_retry_end', success: true },
      );
      if (body.taskId === 'retry-failed') events.push({ type: 'auto_retry_end', success: false, finalError: '429: retry exhausted' });
      res.write(JSON.stringify({ type: 'stdout', data: events.map((event) => JSON.stringify(event)).join('\n') }) + '\n');
      res.end(JSON.stringify({ type: 'complete', success: true, output: '' }) + '\n');
      return;
    }
    res.write(`${JSON.stringify({ type: 'stdout', data: 'working\n' })}\n`);
    const piEvents = [
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', usage: { input: 0 }, assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' } },
      { type: 'tool_execution_start', toolName: 'bash', args: { command: 'echo sk-secret123' } },
      { type: 'tool_execution_update', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'private tool output' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '正在检查服务。' },
      ] } },
      { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: '正在检查服务。' }] } },
      { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'private tool output' }] } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    // Runner stdout frames can split a Pi JSON line; HTTP can split UTF-8 bytes.
    const wire = Buffer.from([
      { type: 'stdout', data: piEvents.slice(0, 13) },
      { type: 'stdout', data: piEvents.slice(13) + 'tail without newline' },
      { type: 'complete', success: true, output: 'done', sessionDir: '/tmp/pi-session', filesModified: ['a.ts'] },
    ].map((event) => JSON.stringify(event)).join('\n'));
    const split = wire.indexOf(Buffer.from('正在')) + 1;
    res.write(wire.subarray(0, split));
    setTimeout(() => res.end(wire.subarray(split)), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  process.env.REMOTE_RUNNER_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
  const stdout: string[] = [];
  const tools: Array<{ toolName: string; preview: string }> = [];

  const result = await executeRemoteRunnerTask({
    nodeName: 'TX-server', taskId: 'task-1', cwd: '/repo', prompt: 'do it', timeout: 5000,
    streamCallbacks: {
      onStdoutChunk: (chunk) => { stdout.push(chunk); },
      onToolEvent: (event) => { tools.push(event); },
    },
  });
  assert.deepEqual(stdout, ['working\n', '正在检查服务。', 'tail without newline']);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolName, 'Bash');
  assert.ok(!tools[0].preview.includes('sk-secret123'));
  assert.equal(result.output, 'done');
  assert.equal(result.sessionId, '/tmp/pi-session');
  assert.deepEqual(result.filesModified, ['a.ts']);
  for (const [taskId, expected] of [
    ['failed', /429: 已达到/], ['retry-failed', /429: retry exhausted/], ['empty', /exited without a response/],
  ] as const) {
    await assert.rejects(executeRemoteRunnerTask({
      nodeName: 'TX-server', taskId, cwd: '/repo', prompt: 'hello', timeout: 5000,
    }), expected);
  }
  const recovered = await executeRemoteRunnerTask({
    nodeName: 'TX-server', taskId: 'recovered', cwd: '/repo', prompt: 'hello', timeout: 5000,
  });
  assert.equal(recovered.output, '恢复成功');
  server.close();
  console.log('remote runner executor test passed');
}

void main();
