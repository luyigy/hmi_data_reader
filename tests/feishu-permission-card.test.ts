import assert from 'node:assert/strict';
import { buildFeishuPermissionCard } from '../src/lib/feishu-api';
import {
  finishPendingTaskRunInteractionRequests,
  isPermissionRequestWithinBoundary,
} from '../src/lib/acpx/interactions';
import { buildFullAccessApprovedCommand } from '../src/lib/feishu-access-approval';
import { waitForInProcessApproval } from '../src/lib/acpx/in-process-approvals';
import { prisma } from '../src/lib/prisma';

const args = {
  interactionRequestId: 'request',
  command: 'npm test',
  kind: 'permission_request',
  workdir: '/workspace/project',
  workspaceBoundary: '/workspace/project',
  approvalScope: '仅批准启动策略边界内的本次操作',
  expiresAt: '2026-07-28T14:00:00.000Z',
  approvalSupported: true,
};
const card = buildFeishuPermissionCard(args);
const content = JSON.stringify(card);
assert.match(content, /npm test/);
assert.match(content, /\/workspace\/project/);
assert.match(content, /仅批准启动策略边界内的本次操作/);
assert.match(content, /2026-07-28T14:00:00.000Z/);
assert.match(content, /approve:request/);
assert.doesNotMatch(JSON.stringify(buildFeishuPermissionCard({
  ...args,
  approvalSupported: false,
  approvalScope: '当前 adapter 不支持原进程批准',
})), /approve:request/);
const inputCard = JSON.stringify(buildFeishuPermissionCard({
  ...args,
  kind: 'input_request',
}));
assert.match(inputCard, /Agent 等待你的确认/);
assert.match(inputCard, /responseText/);
assert.match(inputCard, /answer:request/);
assert.match(inputCard, /deny:request/);

assert.equal(isPermissionRequestWithinBoundary({
  kind: 'permission_request',
  title: 'Codex 请求修改文件',
  rawContent: '/workspace/project/src/index.ts',
  workspaceBoundary: '/workspace/project',
}), true);
assert.equal(isPermissionRequestWithinBoundary({
  kind: 'permission_request',
  title: 'Codex 请求修改文件',
  rawContent: '/workspace/sibling/secret.txt',
  workspaceBoundary: '/workspace/project',
}), false);

assert.deepEqual(buildFullAccessApprovedCommand({
  command: 'grant',
  args: ['full'],
  options: { agent: 'codex' },
}), {
  command: 'new-session',
  args: ['codex'],
  options: { agent: 'codex', profile: 'full_access' },
});

for (const command of ['rights', 'grant'] as const) {
  assert.deepEqual(buildFullAccessApprovedCommand({ command, args: [], options: {} }), {
    command: 'new-session', args: [], options: { all: 'true', profile: 'full_access' },
  });
  assert.deepEqual(buildFullAccessApprovedCommand({ command, args: [], options: { agent: 'kimi-code' } }), {
    command: 'new-session', args: ['kimi-code'], options: { agent: 'kimi-code', profile: 'full_access' },
  });
}

void (async () => {
  const model = prisma.taskRunInteractionRequest as unknown as {
    findMany: (...args: unknown[]) => Promise<Array<{ id: string }>>;
    updateMany: (...args: unknown[]) => Promise<{ count: number }>;
  };
  const originalFindMany = model.findMany;
  const originalUpdateMany = model.updateMany;
  let updatedStatus = '';
  model.findMany = async () => [{ id: 'pending-request' }];
  model.updateMany = async (args: unknown) => {
    updatedStatus = (args as { data: { status: string } }).data.status;
    return { count: 1 };
  };
  try {
    const pending = waitForInProcessApproval('pending-request');
    assert.equal(await finishPendingTaskRunInteractionRequests({
      taskSessionId: 'old-session',
      status: 'cancelled',
    }), 1);
    assert.equal(updatedStatus, 'cancelled');
    assert.deepEqual(await pending, { decision: 'deny', timedOut: false, cancelled: true });
  } finally {
    model.findMany = originalFindMany;
    model.updateMany = originalUpdateMany;
  }
  console.log('Feishu permission card checks passed');
})();
