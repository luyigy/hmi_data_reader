import assert from 'node:assert/strict';
import { AgentReplyState, type AgentMessageInfo } from '../agent-reply-state';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendCodexAgentMessageDelta,
  buildCodexApprovalResponse,
  canRetryCodexAppServerWithJson,
  CodexAppServerError,
  isSuccessfulCodexAppServerExit,
  runCodexAppServer,
  toCodexToolEvent,
  toCodexApprovalRequest,
} from './codex-app-server';
import { buildExecArgs, buildResumeArgs, executeCodexTask } from './codex-agent';
import {
  cancelInProcessApproval,
  resolveInProcessApproval,
  waitForInProcessApproval,
} from '../acpx/in-process-approvals';

const request = toCodexApprovalRequest('item/commandExecution/requestApproval', {
  command: 'git push',
  reason: 'needs network',
});

assert.equal(request?.kind, 'permission_request');
assert.equal(request?.resumeStrategy, 'in_process');
assert.match(request?.rawContent || '', /git push/);
assert.deepEqual(buildCodexApprovalResponse('approve'), { decision: 'accept' });
assert.deepEqual(buildCodexApprovalResponse('deny'), { decision: 'decline' });
assert.deepEqual(
  buildCodexApprovalResponse(
    'approve',
    'item/permissions/requestApproval',
    { permissions: { network: { enabled: true } } },
  ),
  { permissions: { network: { enabled: true } }, scope: 'turn' },
);
assert.deepEqual(
  buildCodexApprovalResponse('deny', 'item/permissions/requestApproval', {}),
  { permissions: {}, scope: 'turn' },
);
assert.equal(
  toCodexApprovalRequest('item/permissions/requestApproval', {
    reason: 'needs network',
    permissions: { network: { enabled: true } },
  })?.resumeStrategy,
  'in_process',
);
assert.equal(isSuccessfulCodexAppServerExit(0, 'partial response'), true);
assert.equal(isSuccessfulCodexAppServerExit(0, ''), false);
assert.equal(isSuccessfulCodexAppServerExit(1, 'partial response'), false);
assert.deepEqual(toCodexToolEvent({ type: 'commandExecution', command: 'npm test' }), {
  toolName: 'Bash', preview: 'npm test', emoji: '💻',
});
assert.deepEqual(toCodexToolEvent({
  type: 'mcpToolCall', tool: 'impact', arguments: { target: 'runCodexAppServer' },
}), { toolName: 'impact', preview: 'runCodexAppServer', emoji: '⚙️' });
assert.equal(toCodexToolEvent({ type: 'agentMessage', text: 'hello' }), null);
assert.equal(appendCodexAgentMessageDelta('', 'First', true), 'First');
assert.deepEqual(
  buildExecArgs(false, 'workspace-write', 'never', true, 'enabled'),
  ['exec', '--json', '--sandbox', 'workspace-write', '--config', 'sandbox_workspace_write.network_access=true', '--ephemeral', '-'],
);
assert.deepEqual(
  buildResumeArgs('thread', false, 'workspace-write', 'never', 'restricted'),
  ['exec', 'resume', 'thread', '--json', '--config', 'sandbox_workspace_write.network_access=false', '-'],
);
assert.equal(appendCodexAgentMessageDelta('First', ' message', false), 'First message');
assert.equal(
  appendCodexAgentMessageDelta('First message', 'Second message', true),
  'First message\n\nSecond message'
);

void (async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-app-server-'));
  const workspace = path.join(fixtureRoot, 'workspace');
  const realCwd = path.join(workspace, 'real');
  const linkedCwd = path.join(workspace, 'linked');
  const bin = path.join(fixtureRoot, 'bin');
  const fixture = path.join(bin, 'codex');
  const log = path.join(workspace, 'requests.ndjson');
  const hostSecret = path.join(tmpdir(), `codex-app-server-host-${process.pid}`);
  await mkdir(realCwd, { recursive: true });
  await mkdir(bin);
  await symlink(realCwd, linkedCwd);
  await writeFile(hostSecret, 'host');
  await writeFile(fixture, `#!/usr/bin/env bash
if [[ "$1" != "app-server" ]]; then
  echo json-fallback >> "$CODEX_FIXTURE_LOG"
  echo '{"type":"thread.started","thread_id":"json-fallback"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"json fallback"}}'
  exit 0
fi
[[ -e "$CODEX_FIXTURE_HOST_SECRET" ]] && echo host-visible >> "$CODEX_FIXTURE_LOG" || echo host-hidden >> "$CODEX_FIXTURE_LOG"
while IFS= read -r line; do
  echo "$line" >> "$CODEX_FIXTURE_LOG"
  [[ "$line" =~ \\"id\\":([0-9]+) ]] && request_id="\${BASH_REMATCH[1]}"
  if [[ "$CODEX_FIXTURE_MODE" == "preturn-failure" && "$line" == *'"method":"initialize"'* ]]; then
    exit 2
  elif [[ "$line" == *'"method":"initialize"'* ]]; then
    echo "{\\"id\\":$request_id,\\"result\\":{}}"
  elif [[ "$line" == *'"method":"account/rateLimits/read"'* ]]; then
    echo "{\\"id\\":$request_id,\\"result\\":{\\"rateLimits\\":{\\"primary\\":{\\"usedPercent\\":25,\\"windowDurationMins\\":300,\\"resetsAt\\":1893456000},\\"secondary\\":null}}}"
  elif [[ "$line" == *'"method":"thread/start"'* ]]; then
    echo "{\\"id\\":$request_id,\\"result\\":{\\"thread\\":{\\"id\\":\\"thread-new\\"}}}"
  elif [[ "$line" == *'"method":"thread/resume"'* ]]; then
    echo "{\\"id\\":$request_id,\\"result\\":{\\"thread\\":{\\"id\\":\\"thread-resumed\\"}}}"
  elif [[ "$line" == *'"method":"turn/start"'* ]]; then
    echo "{\\"id\\":$request_id,\\"result\\":{\\"turn\\":{\\"id\\":\\"turn-1\\"}}}"
    if [[ "$CODEX_FIXTURE_MODE" == "approval" ]]; then
      echo '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"npm test","reason":"test"}}'
    elif [[ "$CODEX_FIXTURE_MODE" != "hang" ]]; then
      echo '{"method":"turn/started","params":{"threadId":"thread-new","turn":{"id":"turn-1"}}}'
      echo '{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"r1","summaryIndex":0,"delta":"Public progress."}}'
      echo '{"method":"item/reasoning/textDelta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"r1","delta":"RAW_CONTENT_MUST_NOT_DISPLAY"}}'
      echo '{"method":"item/completed","params":{"threadId":"thread-new","turnId":"turn-1","item":{"type":"reasoning","id":"r1","summary":["Public progress."],"content":["RAW_CONTENT_MUST_NOT_DISPLAY"]}}}'
      echo '{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"other-thread","turnId":"turn-1","itemId":"r2","summaryIndex":0,"delta":"WRONG_THREAD"}}'
      echo '{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-new","turnId":"old-turn","itemId":"r3","summaryIndex":0,"delta":"OLD_TURN"}}'
      echo '{"method":"item/started","params":{"item":{"type":"agentMessage"}}}'
      echo '{"method":"item/agentMessage/delta","params":{"delta":"done"}}'
      echo '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-new","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":50000,"cachedInputTokens":1000,"outputTokens":2000,"reasoningOutputTokens":500,"totalTokens":52500},"total":{"inputTokens":50000,"cachedInputTokens":1000,"outputTokens":2000,"reasoningOutputTokens":500,"totalTokens":52500},"modelContextWindow":100000}}}'
      echo '{"method":"account/rateLimits/updated","params":{"rateLimits":{"secondary":{"usedPercent":10,"windowDurationMins":10080,"resetsAt":1894060800}}}}'
      echo '{"method":"turn/completed","params":{"threadId":"thread-new","turn":{"id":"turn-1","status":"completed"}}}'
    fi
  elif [[ "$line" == *'"id":99'* ]]; then
    echo '{"method":"item/agentMessage/delta","params":{"delta":"approved"}}'
    echo '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-resumed","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":60000,"cachedInputTokens":1000,"outputTokens":2000,"reasoningOutputTokens":500,"totalTokens":62500},"total":{"inputTokens":90000,"cachedInputTokens":2000,"outputTokens":3000,"reasoningOutputTokens":800,"totalTokens":95800},"modelContextWindow":100000}}}'
    echo '{"method":"turn/completed","params":{"threadId":"thread-resumed","turn":{"id":"turn-1","status":"completed"}}}'
  fi
done
`);
  await chmod(fixture, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_FIXTURE_LOG: log,
    CODEX_FIXTURE_HOST_SECRET: hostSecret,
  };

  let spawnedPid: number | undefined;
  const telemetryOrder: string[] = [];
  const newThreadUsage: Array<{ threadId: string }> = [];
  const quotaEvents: Array<{ snapshot: boolean }> = [];
  const display: { text: string; message?: AgentMessageInfo }[] = [];
  const newThread = await runCodexAppServer({
    prompt: 'new',
    workingDirectory: linkedCwd,
    workspaceRoot: workspace,
    networkAccess: 'restricted',
    codexHome: path.join(workspace, '.codex'),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    timeout: 1_000,
    env,
    onSpawn: (child) => { spawnedPid = child.pid; },
    onThreadStarted: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      telemetryOrder.push('thread');
    },
    streamCallbacks: {
      onStdoutChunk: (text, message) => { display.push({ text, message }); },
      onCodexTokenUsage: (usage) => {
        telemetryOrder.push('usage');
        newThreadUsage.push(usage);
      },
      onCodexRateLimits: (event) => { quotaEvents.push(event); },
    },
  });
  assert.equal(newThread.threadId, 'thread-new');
  assert.equal(newThread.output, 'done');
  const projected = new AgentReplyState();
  display.forEach(item => projected.append(item.text, item.message));
  assert.equal(projected.view().process.split('Public progress.').length - 1, 1, 'Completion snapshots must not duplicate streamed summaries');
  assert.doesNotMatch(JSON.stringify(display), /RAW_CONTENT_MUST_NOT_DISPLAY|WRONG_THREAD|OLD_TURN/);
  assert.ok(display.some(item => item.message?.phase === 'reasoning_summary' && item.message.operation === 'replace'));
  assert.ok(spawnedPid && spawnedPid > 0);
  assert.deepEqual(newThreadUsage.map((usage) => usage.threadId), ['thread-new']);
  assert.deepEqual(telemetryOrder, ['thread', 'usage']);
  assert.deepEqual(quotaEvents.map((event) => event.snapshot), [true, false]);
  const newThreadLog = await readFile(log, 'utf8');
  assert.match(newThreadLog, /host-hidden/);
  assert.match(newThreadLog, new RegExp(`"cwd":"${realCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(newThreadLog, /"sandbox":"workspace-write"/);
  assert.match(newThreadLog, /"approvalPolicy":"never"/);

  await writeFile(log, '');
  const resumedUsage: Array<{ threadId: string }> = [];
  const resumed = await runCodexAppServer({
    prompt: 'resume',
    threadId: 'thread-old',
    workingDirectory: realCwd,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    timeout: 1_000,
    model: 'gpt-test',
    env: { ...env, CODEX_FIXTURE_MODE: 'approval' },
    streamCallbacks: {
      onInteractionRequest: async () => 'approve',
      onCodexTokenUsage: (usage) => { resumedUsage.push(usage); },
    },
  });
  assert.equal(resumed.threadId, 'thread-resumed');
  assert.equal(resumed.output, 'approved');
  assert.deepEqual(resumedUsage.map((usage) => usage.threadId), ['thread-resumed']);
  const resumeLog = await readFile(log, 'utf8');
  assert.match(resumeLog, /"method":"thread\/resume"/);
  assert.match(resumeLog, /"threadId":"thread-old"/);
  assert.match(resumeLog, /"model":"gpt-test"/);
  assert.match(resumeLog, /"id":99,"result":\{"decision":"accept"\}/);

  let timeoutChildPid: number | undefined;
  await assert.rejects(
    runCodexAppServer({
      prompt: 'timeout',
      workingDirectory: realCwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      timeout: 10,
      env: { ...env, CODEX_FIXTURE_MODE: 'hang' },
      onSpawn: (child) => { timeoutChildPid = child.pid; },
    }),
    (error) => error instanceof CodexAppServerError
      && !error.safeToRetryJson
      && /timed out/.test(error.message),
  );
  assert.ok(timeoutChildPid && timeoutChildPid > 0);

  let interruptChild: import('child_process').ChildProcess | undefined;
  await assert.rejects(
    runCodexAppServer({
      prompt: 'interrupt',
      workingDirectory: realCwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      timeout: 1_000,
      env: { ...env, CODEX_FIXTURE_MODE: 'hang' },
      onSpawn: (child) => { interruptChild = child; },
      onThreadStarted: () => { setImmediate(() => interruptChild?.kill('SIGINT')); },
    }),
    (error) => error instanceof CodexAppServerError && !error.safeToRetryJson,
  );

  const safeFailure = new CodexAppServerError('initialize failed', true);
  assert.equal(canRetryCodexAppServerWithJson(safeFailure), true);
  assert.equal(canRetryCodexAppServerWithJson(safeFailure, workspace), false);
  assert.equal(canRetryCodexAppServerWithJson(new CodexAppServerError('turn failed', false)), false);

  const previousPath = process.env.PATH;
  const previousMode = process.env.CODEX_FIXTURE_MODE;
  const previousLog = process.env.CODEX_FIXTURE_LOG;
  const previousHostSecret = process.env.CODEX_FIXTURE_HOST_SECRET;
  process.env.PATH = env.PATH;
  process.env.CODEX_FIXTURE_MODE = 'preturn-failure';
  process.env.CODEX_FIXTURE_LOG = log;
  process.env.CODEX_FIXTURE_HOST_SECRET = hostSecret;
  try {
    const fallback = await executeCodexTask(
      { id: 'fallback', name: 'fallback' },
      {
        workingDirectory: realCwd,
        approvalPolicy: 'on-request',
        timeout: 1_000,
      },
    );
    assert.equal(fallback.success, true);
    assert.equal(fallback.threadId, 'json-fallback');
    assert.equal(fallback.output, 'json fallback');

    await writeFile(log, '');
    const restricted = await executeCodexTask(
      { id: 'restricted', name: 'restricted' },
      {
        workingDirectory: realCwd,
        workspaceRoot: workspace,
        codexHome: path.join(workspace, '.codex'),
        approvalPolicy: 'on-request',
        timeout: 1_000,
      },
    );
    assert.equal(restricted.success, false);
    assert.match(restricted.error || '', /app-server exited/);
    assert.doesNotMatch(await readFile(log, 'utf8'), /json-fallback/);
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.CODEX_FIXTURE_MODE;
    else process.env.CODEX_FIXTURE_MODE = previousMode;
    if (previousLog === undefined) delete process.env.CODEX_FIXTURE_LOG;
    else process.env.CODEX_FIXTURE_LOG = previousLog;
    if (previousHostSecret === undefined) delete process.env.CODEX_FIXTURE_HOST_SECRET;
    else process.env.CODEX_FIXTURE_HOST_SECRET = previousHostSecret;
  }

  const approved = waitForInProcessApproval('approve');
  assert.equal(resolveInProcessApproval('approve', 'approve'), true);
  assert.deepEqual(await approved, { decision: 'approve', timedOut: false });
  assert.equal(resolveInProcessApproval('approve', 'deny'), false);
  assert.deepEqual(await waitForInProcessApproval('timeout', 1), { decision: 'deny', timedOut: true });
  const cancelled = waitForInProcessApproval('cancel');
  assert.equal(cancelInProcessApproval('cancel'), true);
  assert.deepEqual(await cancelled, { decision: 'deny', timedOut: false, cancelled: true });
  assert.equal(cancelInProcessApproval('cancel'), false);
  console.log('codex app-server isolation and lifecycle checks passed');
})();
