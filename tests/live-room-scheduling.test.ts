import assert from 'node:assert/strict';
import {
  orderMembersByRole,
  parseLiveRoomMode,
  shouldRunRoleQueue,
} from '../src/lib/live-room-scheduling';
import {
  getPrimaryReplyTarget,
  getTargetMemberIdsForMessage,
  type DeliveryRoom,
} from '../src/lib/live-room-delivery-routing';

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

const mockRoom: DeliveryRoom = {
  id: 'room-1',
  title: 'Test Room',
  currentTopic: null,
  mode: 'execution',
  currentSpeakerMemberId: 'm1',
  members: [
    { id: 'm1', canReply: true, displayName: 'Codex', backend: 'platform_local', harnessType: 'codex', runtimeAgentId: null, gatewayId: null, role: 'planner' },
    { id: 'm2', canReply: true, displayName: 'Claude', backend: 'platform_local', harnessType: 'claude', runtimeAgentId: null, gatewayId: null, role: 'implementer' },
    { id: 'm3', canReply: true, displayName: 'Deepseek', backend: 'platform_local', harnessType: 'deepseek', runtimeAgentId: null, gatewayId: null, role: 'reviewer' },
  ],
};

// getPrimaryReplyTarget should respect requestedTargetMemberId even if currentSpeakerMemberId is set
const targetForM2 = getPrimaryReplyTarget({
  room: mockRoom,
  sourceMessageSenderMemberId: 'user-1',
  sourceMetadata: null,
  requestedTargetMemberId: 'm2',
});
assert.equal(targetForM2?.id, 'm2', 'Should return m2 when m2 is explicitly requested as target');

// In execution mode without explicit target, getTargetMemberIdsForMessage returns role queue members
const targetMemberIds = getTargetMemberIdsForMessage({
  room: mockRoom,
  sourceMessageSenderMemberId: 'user-1',
  sourceMetadata: null,
  sourceContent: 'do work',
});
assert.deepEqual(targetMemberIds, ['m1', 'm2', 'm3']);

// When triggerLiveRoomAgentReply runs for each member in targetMemberIds, passing targetMemberId must resolve to that member
for (const id of targetMemberIds) {
  const target = getPrimaryReplyTarget({
    room: mockRoom,
    sourceMessageSenderMemberId: 'user-1',
    sourceMetadata: null,
    requestedTargetMemberId: id,
  });
  assert.equal(target?.id, id, `Role queue item ${id} must resolve to ${id}, not currentSpeaker`);
}

console.log('Live Room execution routing tests passed successfully');

