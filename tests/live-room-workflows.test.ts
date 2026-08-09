import assert from 'node:assert/strict';
import {
  buildLiveRoomWorkflowStages,
  liveRoomWorkflowGatePassed,
  missingLiveRoomWorkflowRoles,
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
  member('planner', 'planner'),
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
    ['plan', 'planner'],
    ['plan-review', 'reviewer'],
    ['plan-final', 'planner'],
    ['test-plan', 'tester'],
    ['implement', 'builder'],
    ['code-review', 'reviewer'],
    ['test', 'tester'],
    ['final', 'planner'],
  ]
);

assert.deepEqual(
  buildLiveRoomWorkflowStages('debug', members).map((stage) => stage.id),
  [
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

assert.deepEqual(missingLiveRoomWorkflowRoles(members), []);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'reviewer')), ['reviewer']);
assert.deepEqual(missingLiveRoomWorkflowRoles([
  member('same', 'planner'),
  member('same', 'implementer'),
  member('reviewer', 'reviewer'),
  member('tester', 'tester'),
]), ['implementer']);
assert.equal(buildLiveRoomWorkflowStages('feature', members.slice(1)).length, 0);

assert.equal(liveRoomWorkflowGatePassed('plan-review', 'APPROVED'), true);
assert.equal(liveRoomWorkflowGatePassed('code-review', 'CHANGES_REQUESTED'), false);
assert.equal(liveRoomWorkflowGatePassed('code-review', 'APPROVED but not CHANGES_REQUESTED'), false);
assert.equal(liveRoomWorkflowGatePassed('test', 'PASSED'), true);
assert.equal(liveRoomWorkflowGatePassed('test', 'FAILED'), false);
assert.equal(liveRoomWorkflowGatePassed('test', 'no explicit result'), false);
assert.equal(liveRoomWorkflowGatePassed('implement', 'completed'), null);
