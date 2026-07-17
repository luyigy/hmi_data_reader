import assert from 'node:assert/strict';
import {
  permissionConfigForProfile,
  resolveLiveRoomMemberPermission,
} from '../src/lib/live-room-permissions';

const inherited = permissionConfigForProfile('dev_local');
const member = permissionConfigForProfile('full_access');

assert.equal(
  resolveLiveRoomMemberPermission(null, JSON.stringify(inherited)).profile,
  'dev_local'
);
assert.equal(
  resolveLiveRoomMemberPermission(JSON.stringify(member), JSON.stringify(inherited)).profile,
  'full_access'
);
assert.equal(resolveLiveRoomMemberPermission('{bad json', null).profile, 'safe_local');
