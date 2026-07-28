import assert from 'node:assert/strict';
import { buildWorkflowExecutionCard } from '../src/lib/feishu-workflow';
import { buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';

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
        'configured: preset=workspace · source=config/projects.yaml#example',
        'effective: workdir=/workspace/project · filesystem=workspace_write · temp=isolated_per_run · network=enabled · approval=never',
        `enforcement: ${permissionSnapshot.enforcement.level} · sandbox=${permissionSnapshot.enforcement.sandboxMode} · approval=${permissionSnapshot.enforcement.approvalPolicy} · network=${permissionSnapshot.enforcement.networkAccess} · writable_roots=${permissionSnapshot.enforcement.writableRoots}`,
        'exceptions:',
        ...permissionSnapshot.exceptions.map((exception) => `- ${exception.path} · read_only · ${exception.reason}`),
      ].join('\n'),
    },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '以上指令已投递给 Coding Agent；请等待本阶段完成后再继续。' }] },
  ],
});
