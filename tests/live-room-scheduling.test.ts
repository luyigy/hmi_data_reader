import assert from 'node:assert/strict';
import {
  orderMembersByRole,
  parseLiveRoomMode,
  shouldRunRoleQueue,
} from '../src/lib/live-room-scheduling';

assert.equal(parseLiveRoomMode(' HYBRID '), 'hybrid');
assert.equal(parseLiveRoomMode('invalid'), null);
assert.equal(shouldRunRoleQueue('discussion', '/run build it'), false);
assert.equal(shouldRunRoleQueue('execution', 'build it'), true);
assert.equal(shouldRunRoleQueue('hybrid', 'build it'), false);
assert.equal(shouldRunRoleQueue('hybrid', '/run build it'), true);

assert.deepEqual(
  orderMembersByRole([
    { id: 'test', role: 'tester', sortOrder: 1 },
    { id: 'build', role: 'implementer', sortOrder: 2 },
    { id: 'plan', role: 'planner', sortOrder: 3 },
  ]).map((member) => member.id),
  ['plan', 'build', 'test']
);
