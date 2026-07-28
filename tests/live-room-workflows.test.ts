import assert from 'node:assert/strict';
import {
  buildLiveRoomWorkflowStages,
  parseLiveRoomPlanCommand,
  parseLiveRoomWorkflowCommand,
  planPathFrom,
  selectLiveRoomPlanHost,
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
assert.equal(parseLiveRoomPlanCommand('/plan'), null);
assert.equal(
  planPathFrom('PLAN_PATH: docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'),
  'docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'
);
assert.equal(planPathFrom('PLAN_PATH: docs/../178_PLAN_bad.md'), null);

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
