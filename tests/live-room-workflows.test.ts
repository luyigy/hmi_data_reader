import assert from 'node:assert/strict';
import {
  buildLiveRoomWorkflowStages,
  parseLiveRoomWorkflowCommand,
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

const members = [
  member('builder', 'implementer'),
  member('reviewer', 'reviewer'),
  member('tester', 'tester'),
];

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
