import assert from 'node:assert/strict';
import {
  applyWorkflowPermissionSnapshot,
  buildWorkflowPermissionSnapshot,
  readWorkflowPermissionSnapshot,
  validateWorkflowExecutionPolicy,
} from '../src/lib/workflow-execution-policy';
import { handleWorkflowPolicyCommand } from '../src/lib/feishu-workflow-policy';
import { loadProjectsConfig } from '../src/lib/scheduled-jobs/project-config';

const policy = validateWorkflowExecutionPolicy({ preset: 'workspace' });
assert.deepEqual(policy, { preset: 'workspace' });
assert.throws(() => validateWorkflowExecutionPolicy(undefined), /must be an object/);
assert.throws(() => validateWorkflowExecutionPolicy({ preset: 'full' }), /must be workspace/);
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'workspace', writable_roots: ['/tmp'] }),
  /does not allow custom fields/,
);

const snapshot = buildWorkflowPermissionSnapshot({
  policy,
  projectPath: '/workspace/project',
  source: 'config/projects.yaml#example',
});
assert.equal(snapshot.effective.permissionConfig.writableRoots[0], '/workspace/project');
assert.equal(snapshot.effective.permissionConfig.approvalPolicy, 'never');
assert(snapshot.exceptions.every((exception) => exception.access === 'read_only'));
assert.deepEqual(readWorkflowPermissionSnapshot(snapshot, '/workspace/project'), snapshot);
assert.throws(() => readWorkflowPermissionSnapshot(snapshot, '/workspace/other'), /invalid Workflow permission snapshot/);
const roomPermission = {
  profile: 'full_access',
  sandboxMode: 'danger-full-access',
  networkAccess: 'enabled',
  approvalPolicy: 'on-request',
  writableRoots: [],
} satisfies import('../src/lib/acpx/types').AcpxPermissionConfig;
assert.equal(applyWorkflowPermissionSnapshot(roomPermission, null), roomPermission);
const workflowPermission = applyWorkflowPermissionSnapshot(roomPermission, snapshot);
assert.equal(workflowPermission.sandboxMode, 'workspace-write');
assert.equal(workflowPermission.approvalPolicy, 'never');
assert.deepEqual(workflowPermission.writableRoots, ['/workspace/project']);

void (async () => {
  const project = (await loadProjectsConfig()).projects[0];
  const chatId = String(project.jobs.find((job) => job.type === 'workflow_watcher')?.config.coding_bot_chat_id);
  process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  const context = { chatId, chatType: 'p2p' as const, senderOpenId: 'user', messageId: 'message' };
  assert.match(
    await handleWorkflowPolicyCommand(
      { command: 'workflow', args: ['policy', 'show'], options: {} },
      context,
    ),
    /configured:[\s\S]*effective:[\s\S]*enforcement:[\s\S]*exceptions:/,
  );
  assert.equal(
    await handleWorkflowPolicyCommand(
      { command: 'workflow', args: ['policy', 'set'], options: { preset: 'workspace' } },
      context,
    ),
    '仅配置的 Feishu 管理员可以设置 Workflow 权限策略。',
  );
})();
