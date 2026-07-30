import assert from 'node:assert/strict';
import {
  applyWorkflowPermissionSnapshot,
  buildWorkflowPermissionSnapshot,
  readWorkflowPermissionSnapshot,
  resolveWorkflowCodexBoundary,
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
assert.equal(snapshot.enforcement.level, 'applied');
assert(snapshot.exceptions.every((exception) => exception.access === 'read_only'));
assert.deepEqual(readWorkflowPermissionSnapshot(snapshot, '/workspace/project'), snapshot);
assert.throws(() => readWorkflowPermissionSnapshot(snapshot, '/workspace/other'), /invalid Workflow permission snapshot/);
assert.throws(
  () => readWorkflowPermissionSnapshot(
    { ...snapshot, exceptions: [{ path: '/etc', access: 'read_only', reason: 'tampered' }] },
    '/workspace/project',
  ),
  /invalid Workflow permission snapshot/,
);
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
assert.deepEqual(
  resolveWorkflowCodexBoundary(workflowPermission, '/workspace/project', '/runtime/room-1'),
  {
    workingDirectory: '/workspace/project',
    workspaceRoot: '/workspace/project',
    networkAccess: 'enabled',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    readOnlyPaths: snapshot.exceptions.map((exception) => exception.path),
    codexHome: '/workspace/project/.git/agent-platform/codex/room-1',
  },
);
assert.equal(resolveWorkflowCodexBoundary(roomPermission, '/workspace/project'), null);

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
    /结论：Workflow 正在使用“工作区隔离”策略，所有权限限制均已生效。[\s\S]*\*\*实际权限\*\*[\s\S]*文件写入：仅允许写入上述工作区[\s\S]*\*\*隔离边界\*\*[\s\S]*Codex 内层：完全访问模式（danger-full-access），但不能越过外层工作区沙箱[\s\S]*\*\*只读系统目录\*\*[\s\S]*\*\*配置位置\*\*/,
  );
  assert.equal(
    await handleWorkflowPolicyCommand(
      { command: 'workflow', args: ['policy', 'set'], options: { preset: 'workspace' } },
      context,
    ),
    '仅配置的 Feishu 管理员可以设置 Workflow 权限策略。',
  );
})();
