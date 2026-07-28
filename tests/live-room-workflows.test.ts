import assert from 'node:assert/strict';
import {
  buildLiveRoomWorkflowStages,
  parseLiveRoomPlanCommand,
  parseLiveRoomWorkflowCommand,
  planPathFrom,
  selectLiveRoomPlanHost,
  workflowPlanRevisionPathFrom,
} from '../src/lib/live-room-workflows';

const member = (id: string, role: string) => ({
  id,
  displayName: id,
  backend: 'platform_local',
  harnessType: 'codex',
  gatewayId: null,
  runtimeAgentId: null,
  role,
  roleLabel: null,
  acpxPermissionConfig: null,
  codexModel: null,
  codexReasoningEffort: null,
  gateway: null,
});

assert.deepEqual(parseLiveRoomWorkflowCommand('/run feature build login'), {
  name: 'feature',
  task: 'build login',
});
assert.deepEqual(parseLiveRoomWorkflowCommand('/RUN DEBUG fix crash'), {
  name: 'debug',
  task: 'fix crash',
});
assert.equal(parseLiveRoomWorkflowCommand('/run build login'), null);
assert.deepEqual(parseLiveRoomPlanCommand('/plan --host=codex design login'), {
  host: 'codex', task: 'design login',
});
assert.deepEqual(parseLiveRoomPlanCommand('/plan --revise=docs/288_PLAN_20260728_fix.md update it'), {
  revisionPath: 'docs/288_PLAN_20260728_fix.md',
  task: 'update it',
});
assert.equal(parseLiveRoomPlanCommand('/plan --revise=../outside.md update it'), null);
assert.equal(parseLiveRoomPlanCommand('/plan'), null);
assert.equal(
  planPathFrom('PLAN_PATH: docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'),
  'docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'
);
assert.equal(planPathFrom('PLAN_PATH: docs/../178_PLAN_bad.md'), null);
assert.equal(
  workflowPlanRevisionPathFrom('PLAN_REVISE\nplan_path: docs/288_PLAN_20260728_fix.md\nfeedback:\nclarify'),
  'docs/288_PLAN_20260728_fix.md',
);
assert.equal(workflowPlanRevisionPathFrom('PLAN_REVISE\nplan_path: ../outside.md'), null);
assert.equal(workflowPlanRevisionPathFrom('plan_path: docs/288_PLAN_20260728_fix.md'), null);

const members = [
  member('builder', 'implementer'),
  member('reviewer', 'reviewer'),
  member('tester', 'tester'),
];

assert.equal(selectLiveRoomPlanHost([{ ...member('planner', 'planner'), canReply: true }]).host?.id, 'planner');
assert.match(selectLiveRoomPlanHost([
  { ...member('planner-a', 'planner'), canReply: true },
  { ...member('planner-b', 'planner'), canReply: true },
]).error || '', /--host/);
assert.equal(selectLiveRoomPlanHost([
  { ...member('planner-a', 'planner'), canReply: true },
  { ...member('codex', 'custom'), canReply: true },
], 'codex').host?.id, 'codex');

assert.deepEqual(
  buildLiveRoomWorkflowStages('feature', members).map((stage) => [
    stage.id,
    stage.member.id,
  ]),
  [
    ['analysis-builder', 'builder'],
    ['analysis-reviewer', 'reviewer'],
    ['analysis-tester', 'tester'],
    ['plan', 'builder'],
    ['plan-review', 'reviewer'],
    ['plan-final', 'builder'],
    ['test-plan', 'tester'],
    ['implement', 'builder'],
    ['code-review', 'reviewer'],
    ['test', 'tester'],
    ['final', 'builder'],
  ]
);

assert.deepEqual(
  buildLiveRoomWorkflowStages('debug', members).map((stage) => stage.id),
  [
    'analysis-builder',
    'analysis-reviewer',
    'analysis-tester',
    'reproduce-plan',
    'fix-plan',
    'plan-review',
    'plan-final',
    'test-plan',
    'fix',
    'code-review',
    'test',
    'final',
  ]
);
