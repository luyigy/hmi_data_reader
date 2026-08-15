import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

void (async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'pi-agent-test-'));
  const workspace = path.join(fixtureDir, 'workspace');
  const binary = path.join(fixtureDir, 'pi');
  process.env.PI_AGENT_BIN = binary;

  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--mode" ] && [ "$PI_TEST_CASE" = "fallback" ]; then
  printf 'error: unknown option --mode\\n' >&2
  exit 2
fi
if [ "$1" = "--mode" ] && [ "$PI_TEST_CASE" = "error" ]; then
  printf '{"type":"message_end","message":{"role":"assistant","content":[]},"stopReason":"error","errorMessage":"429 Usage limit reached"}\n'
  exit 0
fi
if [ "$1" = "--print" ]; then
  printf 'legacy output'
  exit 0
fi
printf '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"reading /var/private/key.pem sk-secret123"}]}}\\n'
printf '{"type":"tool_execution_start","toolName":"bash","args":{"command":"cat /var/private/key.pem sk-secret123"}}\\n'
printf '{"type":"tool_execution_end","toolName":"bash","result":"secret body"}\\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\\n'
`);
  await chmod(binary, 0o755);
  await mkdir(workspace);

  try {
    const { executePiAgentTask } = await import('../src/lib/real-agents/pi-agent');
    const chunks: string[] = [];
    const tools: Array<{ toolName: string; preview: string; emoji: string }> = [];
    const result = await executePiAgentTask(
      { id: 'json', name: 'json' },
      {
        workingDirectory: workspace,
        streamCallbacks: {
          onStdoutChunk: (chunk) => { chunks.push(chunk); },
          onToolEvent: (event) => { tools.push(event); },
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.output, 'done');
    assert.deepEqual(chunks, ['reading key.pem [REDACTED]', 'done']);
    assert.deepEqual(tools, [
      { toolName: 'Bash', preview: 'cat key.pem [REDACTED]', emoji: '💻' },
      { toolName: 'Tool Result', preview: '', emoji: '✅' },
    ]);

    process.env.PI_TEST_CASE = 'fallback';
    const fallbackChunks: string[] = [];
    const fallback = await executePiAgentTask(
      { id: 'fallback', name: 'fallback' },
      {
        workingDirectory: workspace,
        streamCallbacks: { onStdoutChunk: (chunk) => { fallbackChunks.push(chunk); } },
      }
    );
    assert.equal(fallback.success, true);
    assert.equal(fallback.output, 'legacy output');
    assert.deepEqual(fallbackChunks, ['legacy output']);

    process.env.PI_TEST_CASE = 'error';
    const failed = await executePiAgentTask(
      { id: 'error', name: 'error' },
      { workingDirectory: workspace }
    );
    assert.equal(failed.success, false);
    assert.equal(failed.error, '429 Usage limit reached');
  } finally {
    delete process.env.PI_AGENT_BIN;
    delete process.env.PI_TEST_CASE;
    await rm(fixtureDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
