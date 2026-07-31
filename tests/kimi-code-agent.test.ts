import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const requireModule = createRequire(__filename);

const exists = async (file: string) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

void (async () => {
  assert.match(
    await readFile(path.join(process.cwd(), 'src/lib/live-room-delivery-execution.ts'), 'utf8'),
    /\['codex', 'claude', 'kimi-code'\]\.includes\(participant\.harnessType\)[\s\S]*\? \{ maxRuntimeMs: null \}/,
  );
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
has_prompt=0
has_forbidden=0
forbidden_arg=""
for arg in "$@"; do
  if [ "$arg" = "--prompt" ]; then has_prompt=1; fi
  if [ "$arg" = "--yolo" ] || [ "$arg" = "--auto" ]; then
    has_forbidden=1
    forbidden_arg="$arg"
  fi
done
if [ "$has_prompt" -eq 1 ] && [ "$has_forbidden" -eq 1 ]; then
  printf 'error: Cannot combine --prompt with %s.\\n' "$forbidden_arg" >&2
  exit 1
fi
case "$KIMI_TEST_CASE" in
  stream)
    printf '{"role":"assistant","content":"Hel'
    sleep 0.02
    printf 'lo","tool_calls":[{"type":"function","id":"call_1","function":{"name":"Bash","arguments":"{\\"command\\":\\"npm test\\"}"}}]}\\n'
    printf '{"role":"tool","tool_call_id":"call_1","content":"passed"}\\n'
    printf '{"role":"assistant","content":" world"}\\n'
    printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_first"}\\n'
    ;;
  structured-error)
    printf '{"type":"error","error":"model unavailable"}\\n'
    ;;
  nonzero)
    printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_bad"}\\n'
    printf 'Kimi process failed' >&2
    exit 7
    ;;
  timeout)
    printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_bad"}\\n'
    sleep 2
    ;;
  stop)
    printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_bad"}\\n'
    sleep 2
    ;;
  fallback)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--session" ]; then
        printf 'Session "%s" not found.\\n' "$2" >&2
        exit 1
      fi
      shift
    done
    printf '{"role":"assistant","content":"fresh"}\\n'
    printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_fresh"}\\n'
    ;;
  resume)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--session" ] && [ "$2" = "ses_first" ]; then
        printf '{"role":"assistant","content":"inherited"}\\n'
        printf '{"role":"meta","type":"session.resume_hint","session_id":"ses_first"}\\n'
        exit 0
      fi
      shift
    done
    printf 'Session not supplied' >&2
    exit 2
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
    const { persistPlatformLocalSessionMetadata } = await import('../src/lib/acpx/runner-metadata');

    assert.equal(await isKimiCodeAvailable(), true);
    assert.equal(await getKimiCodeVersion(), '0.29.2');
    const adapter = getHarnessAdapter('kimi-code');
    assert.equal(adapter?.displayName, 'Kimi Code CLI');

    const streamedChunks: string[] = [];
    const toolEvents: Array<{ toolName: string; preview: string; emoji: string }> = [];
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
        onToolEvent: (event) => {
          toolEvents.push(event);
        },
      },
      [],
      { transcript: '', latestUserMessage: null }
    );
    assert.equal(streamed.output, 'Hello world');
    assert.deepEqual(streamedChunks, ['Hello', ' world']);
    assert.deepEqual(toolEvents, [{ toolName: 'Bash', preview: 'npm test', emoji: '💻' }]);
    assert.equal(streamed.sessionId, 'ses_first');
    assert.equal(streamed.sessionKind, 'kimi_session');
    clearRunningProcess('participant');

    process.env.KIMI_TEST_CASE = 'resume';
    const resumed = await executeViaLocalHarness(
      {
        taskId: 'resume',
        taskName: 'resume',
        orchestrationMode: 'single',
        participants: [{ ...participant, resumeSessionId: 'ses_first' }],
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
      'resume-run',
      'resume-participant',
      {
        ...participant,
        resumeSessionId: 'ses_first',
        continuationSessionKind: 'kimi_session',
        continuationMessage: 'continue',
      },
      {},
      [],
      { transcript: '', latestUserMessage: null }
    );
    assert.equal(resumed.output, 'inherited');
    assert.equal(resumed.sessionId, 'ses_first');
    assert.equal(resumed.sessionKind, 'kimi_session');
    assert.deepEqual(adapter?.readContinuation?.({ lastSessionId: ' ses_first ' }), {
      sessionId: 'ses_first',
      sessionKind: 'kimi_session',
    });
    clearRunningProcess('resume-participant');

    const { prisma } = await import('../src/lib/prisma');
    const taskRunFindUnique = prisma.taskRun.findUnique;
    const taskRunUpdate = prisma.taskRun.update;
    const participantFindUnique = prisma.taskRunParticipant.findUnique;
    const participantUpdate = prisma.taskRunParticipant.update;
    let taskRunMetadata = '';
    let participantMetadata = '';
    prisma.taskRun.findUnique = (async () => ({ controlMetadata: '{}' })) as unknown as typeof prisma.taskRun.findUnique;
    prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: '{}' })) as unknown as typeof prisma.taskRunParticipant.findUnique;
    prisma.taskRun.update = (async (args: { data: { controlMetadata: string } }) => {
      taskRunMetadata = args.data.controlMetadata;
      return {};
    }) as unknown as typeof prisma.taskRun.update;
    prisma.taskRunParticipant.update = (async (args: { data: { controlMetadata: string } }) => {
      participantMetadata = args.data.controlMetadata;
      return {};
    }) as unknown as typeof prisma.taskRunParticipant.update;
    try {
      await persistPlatformLocalSessionMetadata(
        'resume-run',
        'resume-participant',
        'kimi_session',
        'ses_first'
      );
    } finally {
      prisma.taskRun.findUnique = taskRunFindUnique;
      prisma.taskRun.update = taskRunUpdate;
      prisma.taskRunParticipant.findUnique = participantFindUnique;
      prisma.taskRunParticipant.update = participantUpdate;
    }
    for (const metadata of [taskRunMetadata, participantMetadata]) {
      assert.match(metadata, /"lastSessionId":"ses_first"/);
      assert.match(metadata, /"lastSessionKind":"kimi_session"/);
      assert.match(metadata, /"latestSessionId":"ses_first"/);
      assert.match(metadata, /"latestSessionKind":"kimi_session"/);
    }

    const runnerModule = requireModule('../src/lib/acpx/runner') as {
      executeAcpxTaskRun: typeof import('../src/lib/acpx/runner').executeAcpxTaskRun;
    };
    const executeAcpxTaskRun = runnerModule.executeAcpxTaskRun;
    let attempts = 0;
    runnerModule.executeAcpxTaskRun = (async (request) => {
      attempts += 1;
      const fallbackParticipant = request.participants[0];
      try {
        await executeViaLocalHarness(
          request,
          `fallback-run-${attempts}`,
          `fallback-participant-${attempts}`,
          fallbackParticipant,
          {},
          [],
          { transcript: '', latestUserMessage: null }
        );
        return { participants: [{ status: 'completed' }] };
      } catch (error) {
        return {
          participants: [{
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    }) as typeof runnerModule.executeAcpxTaskRun;
    try {
      process.env.KIMI_TEST_CASE = 'fallback';
      const { executeAcpxTaskRunWithContinuationFallback } =
        await import('../src/lib/acpx/continuation-retry');
      const fallbackResult = await executeAcpxTaskRunWithContinuationFallback({
        request: {
          taskId: 'fallback',
          taskName: 'fallback',
          orchestrationMode: 'single',
          participants: [{
            ...participant,
            resumeSessionId: 'missing',
            continuationSessionKind: 'kimi_session',
            continuationMessage: 'continue',
          }],
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
      });
      assert.equal(attempts, 2);
      assert.equal(fallbackResult.participants[0]?.status, 'completed');
    } finally {
      runnerModule.executeAcpxTaskRun = executeAcpxTaskRun;
      clearRunningProcess('fallback-participant-1');
      clearRunningProcess('fallback-participant-2');
    }

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
    assert.equal(nonzero.sessionId, undefined);

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
    assert.equal(timedOut.sessionId, undefined);

    process.env.KIMI_TEST_CASE = 'stop';
    const stopped = await executeKimiCodeTask(
      { id: 'stop', name: 'stop' },
      {
        workingDirectory: workspace,
        permissionProfile: 'full_access',
        timeout: 1000,
        onSpawn: (child) => {
          setTimeout(() => child.kill('SIGTERM'), 20);
        },
      }
    );
    assert.equal(stopped.success, false);
    assert.equal(stopped.sessionId, undefined);

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
