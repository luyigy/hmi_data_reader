import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeRemoteSshTask } from '../src/lib/remote-harness/ssh-executor';

void (async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'remote-ssh-pi-progress-'));
  const ssh = path.join(fixtureDir, 'ssh');
  const originalPath = process.env.PATH;

  await writeFile(ssh, `#!/bin/sh
cat >/dev/null
printf '__ACPX_REMOTE_COMMAND_START__\\n' >&2
printf '{"type":"tool_execution_start","toolName":"bash","args":{"command":"pwd"}}\\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"检查完成"}]}}\\n'
`);
  await chmod(ssh, 0o755);
  process.env.PATH = `${fixtureDir}:${originalPath || ''}`;

  try {
    const chunks: string[] = [];
    const tools: string[] = [];
    const execute = () => executeRemoteSshTask(
      { id: 'progress', name: 'progress' },
      {
        timeout: 5_000,
        harnessType: 'pi-agent',
        host: {
          id: 'test',
          label: 'test',
          host: 'test',
          port: 22,
          sshUser: 'test',
          authType: 'ssh_key',
          privateKey: 'test-key',
          workingDirectory: null,
          status: 'online',
          viaNetwork: 'test',
          supportedHarnesses: ['pi-agent'],
        },
        streamCallbacks: {
          onStdoutChunk: (chunk) => { chunks.push(chunk); },
          onToolEvent: (event) => { tools.push(event.toolName); },
        },
      },
    );

    const result = await execute();
    assert.equal(result.output, '检查完成');
    assert.deepEqual(chunks, ['检查完成']);
    assert.deepEqual(tools, ['Bash']);
    // Pi can report provider failure while the SSH process exits with code zero.
    await writeFile(ssh, `#!/bin/sh
cat >/dev/null
printf '%s' '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"429: quota exceeded"}}'
`);
    await assert.rejects(execute(), /429: quota exceeded/);
  } finally {
    process.env.PATH = originalPath;
    await rm(fixtureDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
