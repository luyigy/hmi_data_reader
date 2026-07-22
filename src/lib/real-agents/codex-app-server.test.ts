import assert from 'node:assert/strict';
import { buildCodexApprovalResponse, toCodexApprovalRequest } from './codex-app-server';
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

void (async () => {
  const approved = waitForInProcessApproval('approve');
  assert.equal(resolveInProcessApproval('approve', 'approve'), true);
  assert.deepEqual(await approved, { decision: 'approve', timedOut: false });
  assert.equal(resolveInProcessApproval('approve', 'deny'), false);
  assert.deepEqual(await waitForInProcessApproval('timeout', 1), { decision: 'deny', timedOut: true });
  console.log('codex app-server approval checks passed');
})();
