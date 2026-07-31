import assert from 'node:assert/strict';
import { handleWorkflowPolicyCommand } from '../src/lib/feishu-workflow-policy';
import { loadProjectsConfig, type JobConfig } from '../src/lib/scheduled-jobs/project-config';
import {
  canManageWorkflowAutonomy,
  configuredWorkflowAutonomy,
  decideWorkflowAutonomyChange,
  resolveWorkflowAutonomy,
  workflowAutonomyAllows,
} from '../src/lib/scheduled-jobs/workflow-autonomy';

const job = (workflow_autonomy?: unknown): JobConfig => ({
  id: 'workflow-watcher',
  type: 'workflow_watcher',
  schedule: '* * * * *',
  enabled: true,
  mode: 'active',
  config: workflow_autonomy === undefined ? {} : { workflow_autonomy },
});

assert.equal(configuredWorkflowAutonomy(job()), 'manual');
assert.equal(configuredWorkflowAutonomy(job('semi_auto')), 'semi_auto');
assert.throws(() => configuredWorkflowAutonomy(job('full_auto')), /workflow_autonomy is invalid/);
assert.deepEqual(resolveWorkflowAutonomy(job('semi_auto'), null), { mode: 'semi_auto', source: 'config' });
assert.deepEqual(resolveWorkflowAutonomy(job('auto'), { mode: 'broken' }), {
  mode: 'manual',
  source: 'safe_fallback',
});

const advances = ['revision', 'start_first_slice', 'next_slice', 'resume_parent'] as const;
assert.deepEqual(advances.map((advance) => workflowAutonomyAllows('manual', advance, 'schedule')), [
  false, false, false, false,
]);
assert.deepEqual(advances.map((advance) => workflowAutonomyAllows('semi_auto', advance, 'schedule')), [
  true, true, true, false,
]);
assert.deepEqual(advances.map((advance) => workflowAutonomyAllows('auto', advance, 'schedule')), [
  true, true, true, true,
]);
assert(advances.every((advance) => workflowAutonomyAllows('manual', advance, 'manual')));
assert(!workflowAutonomyAllows('auto', 'unknown', 'schedule'));

assert(canManageWorkflowAutonomy('admin', true, []));
assert(canManageWorkflowAutonomy('approver', false, ['approver']));
assert(!canManageWorkflowAutonomy('member', false, ['approver']));
assert.equal(decideWorkflowAutonomyChange({
  currentMode: 'manual',
  currentHead: 'new',
  expectedHead: 'old',
  requestedMode: 'auto',
}), 'stale');
assert.equal(decideWorkflowAutonomyChange({
  currentMode: 'semi_auto',
  currentHead: 'same',
  expectedHead: 'same',
  requestedMode: 'semi_auto',
}), 'unchanged');
assert.equal(decideWorkflowAutonomyChange({
  currentMode: 'manual',
  currentHead: 'same',
  expectedHead: 'same',
  requestedMode: 'auto',
}), 'update');

void (async () => {
  const project = (await loadProjectsConfig()).projects[0];
  assert.equal(await handleWorkflowPolicyCommand({
    command: 'workflow',
    args: ['autonomy', 'set', 'manual'],
    options: { head: '0'.repeat(40) },
  }, {
    chatId: project.feishu.chat_id,
    chatType: 'group',
    senderOpenId: 'not-authorized',
    messageId: 'message',
  }), '只有平台管理员或项目审批人可以切换 Workflow 自治模式。');
  assert.equal(await handleWorkflowPolicyCommand({
    command: 'workflow',
    args: ['autonomy', 'show'],
    options: {},
  }, {
    chatId: 'unbound',
    chatType: 'group',
    senderOpenId: 'not-authorized',
    messageId: 'message',
  }), '当前 Feishu 会话未绑定 Workflow 项目。');
  console.log('workflow autonomy checks passed');
})();
