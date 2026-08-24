import assert from 'node:assert/strict';
import {
  formatLiveRoomPermissionLabel,
  permissionConfigForProfile,
  resolveLiveRoomMemberPermission,
} from '../src/lib/live-room-permissions';

assert.equal(formatLiveRoomPermissionLabel(JSON.stringify(permissionConfigForProfile('full_access'))), 'Full Access');
assert.equal(formatLiveRoomPermissionLabel(null), 'Safe Local');

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
