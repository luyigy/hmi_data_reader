import assert from 'node:assert/strict';
import {
  appendCodexAgentMessageDelta,
  buildCodexApprovalResponse,
  isSuccessfulCodexAppServerExit,
  toCodexToolEvent,
  toCodexApprovalRequest,
} from './codex-app-server';
import { resolveInProcessApproval, waitForInProcessApproval } from '../acpx/in-process-approvals';

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
  console.log('codex app-server approval checks passed');
})();
