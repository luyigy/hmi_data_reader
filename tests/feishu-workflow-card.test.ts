import assert from 'node:assert/strict';
import { buildWorkflowExecutionCard } from '../src/lib/feishu-workflow';
import {
  buildWorkflowPermissionSnapshot,
  detectWorkflowPermissionDowngrade,
} from '../src/lib/workflow-execution-policy';
import type { AcpxPermissionConfig } from '../src/lib/acpx/types';

const context = [
  '**所属 PLAN**：276_PLAN.md',
  '**当前或将执行的 Slice**：S04',
  '**计划进度**：in_progress',
  '**文档状态**：completed',
  '**下一动作**：next_slice',
].join('\n');
const instruction = '读取合同，只执行 S04。';
const permissionSnapshot = buildWorkflowPermissionSnapshot({
  policy: { preset: 'workspace' },
  projectPath: '/workspace/project',
  source: 'config/projects.yaml#example',
});
const card = buildWorkflowExecutionCard(context, `${context}\n\n${instruction}`, permissionSnapshot);

assert.deepEqual(card, {
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: 'Workflow · Coding Session' } },
  elements: [
    { tag: 'markdown', content: context },
    { tag: 'hr' },
    { tag: 'markdown', content: instruction },
    {
      tag: 'markdown',
      content: [
        '**Workflow permissions**',
        '结论：Workflow 正在使用“工作区隔离”策略，所有权限限制均已生效。',
        '',
        '**实际权限**',
        '- 工作目录：/workspace/project',
        '- 文件写入：仅允许写入上述工作区',
        '- 网络访问：允许',
        '- 临时目录：每次运行独立，运行结束后不复用',
        '- 运行中审批：不弹出审批（approval=never）',
        '',
        '**隔离边界**',
        '- 外层：Bubblewrap 工作区沙箱',
        '- Codex 内层：完全访问模式（danger-full-access），但不能越过外层工作区沙箱',
        '- 沙箱：已生效',
        '- 审批策略：已生效',
        '- 网络策略：已生效',
        '- 可写目录限制：已生效',
        '',
        '**只读系统目录**',
        ...permissionSnapshot.exceptions.map((exception) =>
          `- ${exception.path}：只读；${exception.reason === 'Shared Agent skills'
            ? '共享 Agent Skills'
            : 'Codex 认证、配置、插件和规则'}`),
        '',
        '**配置位置**',
        '- 策略预设：工作区隔离（workspace）',
        '- 配置来源：config/projects.yaml#example',
      ].join('\n'),
    },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '以上指令已投递给 Coding Agent；请等待本阶段完成后再继续。' }] },
  ],
});

// S02: workspace job + full_access member → the execution card highlights the downgrade.
const fullAccessPermission: AcpxPermissionConfig = {
  profile: 'full_access',
  sandboxMode: 'danger-full-access',
  networkAccess: 'enabled',
  approvalPolicy: 'never',
  writableRoots: [],
};
const safeLocalPermission: AcpxPermissionConfig = {
  profile: 'safe_local',
  sandboxMode: 'workspace-write',
  networkAccess: 'enabled',
  approvalPolicy: 'never',
  writableRoots: ['/workspace/project'],
};

const downgrade = detectWorkflowPermissionDowngrade({
  policy: { preset: 'workspace' },
  members: [
    { displayName: 'kimi-code', permission: fullAccessPermission },
    { displayName: 'codex', permission: safeLocalPermission },
  ],
});
assert.ok(downgrade);
assert.deepEqual(downgrade.members, ['kimi-code']);
assert.match(downgrade.notice, /权限降级：成员拥有 full_access/);
assert.ok(downgrade.notice.includes('kimi-code'));

const cardMarkdown = (element: { tag: string; content?: string }) =>
  element.tag === 'markdown' ? element.content ?? '' : '';

const downgradedCard = buildWorkflowExecutionCard(
  context,
  `${context}\n\n${instruction}`,
  permissionSnapshot,
  undefined,
  downgrade.notice,
);
const downgradeIndex = downgradedCard.elements.findIndex(
  (element) => cardMarkdown(element).includes('权限降级'),
);
assert.ok(downgradeIndex > -1, 'downgrade warning must be rendered');
const permissionsIndex = downgradedCard.elements.findIndex(
  (element) => cardMarkdown(element).startsWith('**Workflow permissions**'),
);
assert.ok(downgradeIndex < permissionsIndex, 'downgrade warning must precede the permissions block');

// No downgrade when the member is not full_access.
assert.equal(detectWorkflowPermissionDowngrade({
  policy: { preset: 'workspace' },
  members: [{ displayName: 'codex', permission: safeLocalPermission }],
}), null);

// S02: full_access job + full_access member → respected, no warning, no sandbox snapshot.
assert.equal(detectWorkflowPermissionDowngrade({
  policy: { preset: 'full_access' },
  members: [{ displayName: 'kimi-code', permission: fullAccessPermission }],
}), null);
const fullAccessSnapshot = buildWorkflowPermissionSnapshot({
  policy: { preset: 'full_access' },
  projectPath: '/workspace/project',
  source: 'config/projects.yaml#example',
});
assert.equal(fullAccessSnapshot.effective.filesystem, 'full_access');
const fullAccessCard = buildWorkflowExecutionCard(
  context,
  `${context}\n\n${instruction}`,
  fullAccessSnapshot,
);
assert.equal(fullAccessCard.elements.filter(
  (element) => cardMarkdown(element).includes('权限降级'),
).length, 0);
