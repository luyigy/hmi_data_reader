import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exists = async (file: string) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

void (async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'kimi-code-test-'));
  const workspace = path.join(fixtureDir, 'workspace');
  const binary = path.join(fixtureDir, 'kimi');
  const outside = path.join(fixtureDir, 'outside.txt');
  const originalBinary = process.env.KIMI_CODE_CLI_PATH;
  process.env.KIMI_CODE_CLI_PATH = binary;

  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "kimi version 0.29.2"
  exit 0
fi
case "$KIMI_TEST_CASE" in
  stream)
    printf '{"role":"assistant","content":"Hel'
    sleep 0.02
    printf 'lo"}\\n{"role":"tool","content":"ignored"}\\n'
    printf '{"role":"assistant","content":" world"}\\n'
    ;;
  structured-error)
    printf '{"type":"error","error":"model unavailable"}\\n'
    ;;
  nonzero)
    printf 'Kimi process failed' >&2
    exit 7
    ;;
  timeout)
    sleep 2
    ;;
  write)
    printf 'host write' > "$KIMI_OUTSIDE_TARGET"
    printf '{"role":"assistant","content":"wrote"}\\n'
    ;;
esac
`);
  await chmod(binary, 0o755);
  await mkdir(workspace);

  try {
    const {
      executeKimiCodeTask,
      getKimiCodeVersion,
      isKimiCodeAvailable,
    } = await import('../src/lib/real-agents/kimi-code-agent');
    const { getHarnessAdapter } = await import('../src/lib/harness');
    const { executeViaLocalHarness } = await import('../src/lib/acpx/runner-harness');
    const { clearRunningProcess } = await import('../src/lib/acpx/process-registry');

    assert.equal(await isKimiCodeAvailable(), true);
    assert.equal(await getKimiCodeVersion(), '0.29.2');
    const adapter = getHarnessAdapter('kimi-code');
    assert.equal(adapter?.displayName, 'Kimi Code CLI');

    const streamedChunks: string[] = [];
    process.env.KIMI_TEST_CASE = 'stream';
    const participant = {
      gatewayId: 'platform-local',
      executionBackend: 'platform_local' as const,
      harnessType: 'kimi-code',
      role: 'custom',
    };
    const streamed = await executeViaLocalHarness(
      {
        taskId: 'stream',
        taskName: 'stream',
        orchestrationMode: 'single',
        participants: [participant],
        workingDirectory: workspace,
        permissionConfig: {
          profile: 'safe_local',
          sandboxMode: 'workspace-write',
          networkAccess: 'restricted',
          approvalPolicy: 'never',
          writableRoots: [workspace],
        },
        watchdogConfig: { maxRuntimeMs: 1000 },
      },
      'run',
      'participant',
      participant,
      {
        onStdoutChunk: (chunk) => {
          streamedChunks.push(chunk);
        },
      },
      [],
      { transcript: '', latestUserMessage: null }
    );
    assert.equal(streamed.output, 'Hello world');
    assert.deepEqual(streamedChunks, ['Hello', ' world']);
    clearRunningProcess('participant');

    process.env.KIMI_TEST_CASE = 'structured-error';
    const structuredError = await executeKimiCodeTask(
      { id: 'error', name: 'error' },
      {
        workingDirectory: workspace,
        workspaceRoot: workspace,
        permissionProfile: 'safe_local',
        timeout: 1000,
      }
    );
    assert.equal(structuredError.success, false);
    assert.equal(structuredError.error, 'model unavailable');

    process.env.KIMI_TEST_CASE = 'nonzero';
    const nonzero = await executeKimiCodeTask(
      { id: 'nonzero', name: 'nonzero' },
      {
        workingDirectory: workspace,
        permissionProfile: 'full_access',
        timeout: 1000,
      }
    );
    assert.equal(nonzero.success, false);
    assert.equal(nonzero.error, 'Kimi process failed');

    process.env.KIMI_TEST_CASE = 'timeout';
    const timedOut = await executeKimiCodeTask(
      { id: 'timeout', name: 'timeout' },
      {
        workingDirectory: workspace,
        permissionProfile: 'full_access',
        timeout: 20,
      }
    );
    assert.equal(timedOut.success, false);
    assert.equal(timedOut.error, 'Kimi Code execution timed out after 20ms');

    process.env.KIMI_TEST_CASE = 'write';
    process.env.KIMI_OUTSIDE_TARGET = outside;
    const sandboxed = await executeKimiCodeTask(
      { id: 'sandboxed', name: 'sandboxed' },
      {
        workingDirectory: workspace,
        workspaceRoot: workspace,
        permissionProfile: 'safe_local',
        timeout: 1000,
      }
    );
    assert.equal(sandboxed.success, true);
    assert.equal(await exists(outside), false);

    const fullAccess = await executeKimiCodeTask(
      { id: 'full', name: 'full' },
      {
        workingDirectory: workspace,
        permissionProfile: 'full_access',
        timeout: 1000,
      }
    );
    assert.equal(fullAccess.success, true);
    assert.equal(await readFile(outside, 'utf8'), 'host write');
  } finally {
    process.env.KIMI_CODE_CLI_PATH = originalBinary;
    delete process.env.KIMI_TEST_CASE;
    delete process.env.KIMI_OUTSIDE_TARGET;
    await rm(fixtureDir, { recursive: true, force: true });
  }
})();
