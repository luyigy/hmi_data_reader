import assert from 'node:assert/strict';
import {
  applyWorkflowPermissionSnapshot,
  buildWorkflowPermissionSnapshot,
  readWorkflowPermissionSnapshot,
  resolveWorkflowCodexBoundary,
  validateWorkflowExecutionPolicy,
  workflowSnapshotExtraRoots,
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

// S01: full_access preset validation
const fullAccessPolicy = validateWorkflowExecutionPolicy({ preset: 'full_access' });
assert.deepEqual(fullAccessPolicy, { preset: 'full_access' });
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'full_access', note: 'x' }),
  /does not allow custom fields/,
);

// S01: workspace extra roots validation
const extrasPolicy = validateWorkflowExecutionPolicy({
  preset: 'workspace',
  extraWritableRoots: ['/data/shared', '/data/shared/'],
  extraReadOnlyPaths: ['/opt/cache'],
});
assert.deepEqual(extrasPolicy, {
  preset: 'workspace',
  extraWritableRoots: ['/data/shared'],
  extraReadOnlyPaths: ['/opt/cache'],
});
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'workspace', extraWritableRoots: ['relative/path'] }),
  /extraWritableRoots entries must be absolute paths/,
);
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'workspace', extraWritableRoots: ['/a/../../etc'] }),
  /extraWritableRoots entries must not contain '\.\.' segments/,
);
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'workspace', extraReadOnlyPaths: ['/'] }),
  /extraReadOnlyPaths entries must not be the filesystem root/,
);
assert.throws(
  () => validateWorkflowExecutionPolicy({ preset: 'workspace', extraWritableRoots: '/data' }),
  /extraWritableRoots must be an array of strings/,
);

// S01: workspace + extras snapshot round-trip and tamper rejection
const extrasSnapshot = buildWorkflowPermissionSnapshot({
  policy: extrasPolicy,
  projectPath: '/workspace/project',
  source: 'config/projects.yaml#extras',
});
assert.deepEqual(
  extrasSnapshot.effective.permissionConfig.writableRoots,
  ['/workspace/project', '/data/shared'],
);
assert.equal(extrasSnapshot.exceptions.length, 3);
assert.deepEqual(extrasSnapshot.exceptions[2], {
  path: '/opt/cache',
  access: 'read_only',
  reason: 'Workflow 额外只读目录',
});
assert.deepEqual(readWorkflowPermissionSnapshot(extrasSnapshot, '/workspace/project'), extrasSnapshot);
assert.throws(
  () => readWorkflowPermissionSnapshot(
    {
      ...extrasSnapshot,
      effective: {
        ...extrasSnapshot.effective,
        permissionConfig: {
          ...extrasSnapshot.effective.permissionConfig,
          writableRoots: ['/workspace/project', '/etc'],
        },
      },
    },
    '/workspace/project',
  ),
  /invalid Workflow permission snapshot/,
);
assert.throws(
  () => readWorkflowPermissionSnapshot(
    { ...extrasSnapshot, exceptions: extrasSnapshot.exceptions.slice(0, 2) },
    '/workspace/project',
  ),
  /invalid Workflow permission snapshot/,
);
assert.deepEqual(workflowSnapshotExtraRoots(
  applyWorkflowPermissionSnapshot(roomPermission, extrasSnapshot),
), { extraWritableRoots: ['/data/shared'], extraReadOnlyPaths: ['/opt/cache'] });
assert.deepEqual(workflowSnapshotExtraRoots(roomPermission), {
  extraWritableRoots: [],
  extraReadOnlyPaths: [],
});

// S01: full_access snapshot round-trip, tamper rejection, member permission pass-through
const fullAccessSnapshot = buildWorkflowPermissionSnapshot({
  policy: fullAccessPolicy,
  projectPath: '/workspace/project',
  source: 'config/projects.yaml#full-access',
});
assert.equal(fullAccessSnapshot.effective.filesystem, 'full_access');
assert.equal(fullAccessSnapshot.effective.temporaryDirectory, 'shared');
assert.equal(fullAccessSnapshot.effective.permissionConfig.profile, 'full_access');
assert.deepEqual(fullAccessSnapshot.exceptions, []);
assert.equal(fullAccessSnapshot.enforcement.level, 'recorded_only');
assert.deepEqual(
  readWorkflowPermissionSnapshot(fullAccessSnapshot, '/workspace/project'),
  fullAccessSnapshot,
);
assert.throws(
  () => readWorkflowPermissionSnapshot(fullAccessSnapshot, '/workspace/other'),
  /invalid Workflow permission snapshot/,
);
assert.throws(
  () => readWorkflowPermissionSnapshot(
    {
      ...fullAccessSnapshot,
      effective: { ...fullAccessSnapshot.effective, filesystem: 'workspace_write' },
    },
    '/workspace/project',
  ),
  /invalid Workflow permission snapshot/,
);
const fullAccessApplied = applyWorkflowPermissionSnapshot(roomPermission, fullAccessSnapshot);
assert.equal(fullAccessApplied.profile, 'full_access');
assert.equal(fullAccessApplied.sandboxMode, 'danger-full-access');
assert.equal(fullAccessApplied.approvalPolicy, 'on-request');
assert.equal(
  (fullAccessApplied as { workflowPermissionSnapshot?: unknown }).workflowPermissionSnapshot,
  fullAccessSnapshot,
);
assert.equal(resolveWorkflowCodexBoundary(fullAccessApplied, '/workspace/project'), null);

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
