import assert from 'node:assert/strict';
import {
  appendCodexAgentMessageDelta,
  buildCodexApprovalResponse,
  isSuccessfulCodexAppServerExit,
  toCodexToolEvent,
  toCodexApprovalRequest,
} from './codex-app-server';
import { buildExecArgs, buildResumeArgs } from './codex-agent';
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
  const approved = waitForInProcessApproval('approve');
  assert.equal(resolveInProcessApproval('approve', 'approve'), true);
  assert.deepEqual(await approved, { decision: 'approve', timedOut: false });
  assert.equal(resolveInProcessApproval('approve', 'deny'), false);
  assert.deepEqual(await waitForInProcessApproval('timeout', 1), { decision: 'deny', timedOut: true });
  const cancelled = waitForInProcessApproval('cancel');
  assert.equal(cancelInProcessApproval('cancel'), true);
  assert.deepEqual(await cancelled, { decision: 'deny', timedOut: false, cancelled: true });
  assert.equal(cancelInProcessApproval('cancel'), false);
  console.log('codex app-server approval checks passed');
})();
