import assert from 'node:assert/strict';
import {
  selectRoomRestrictionTargets,
  supportsRoomWorkspaceConstraint,
} from '../src/lib/feishu-room-controls';

const members = [
  { id: 'user', memberType: 'user', canReply: false },
  { id: 'agent-1', memberType: 'agent', canReply: true },
  { id: 'agent-2', memberType: 'agent', canReply: true },
  { id: 'offline', memberType: 'agent', canReply: false },
];

assert.deepEqual(
  selectRoomRestrictionTargets(members, 'all').map((member) => member.id),
  ['agent-1', 'agent-2'],
);
assert.deepEqual(
  selectRoomRestrictionTargets(members, 'agent-2').map((member) => member.id),
  ['agent-2'],
);
assert.deepEqual(selectRoomRestrictionTargets(members, 'missing'), []);
assert.equal(supportsRoomWorkspaceConstraint({
  harnessType: 'codex',
  backend: 'platform_local',
}, 'safe_local'), true);
assert.equal(supportsRoomWorkspaceConstraint({
  harnessType: 'claude',
  backend: 'platform_local',
}, 'safe_local'), false);

console.log('Feishu room control checks passed');
