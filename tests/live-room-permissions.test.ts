import assert from 'node:assert/strict';
import { DEFAULT_ACPX_PERMISSION_CONFIG, normalizeAcpxPermissionConfig } from '../src/lib/acpx/permissions';
import {
  formatLiveRoomPermissionLabel,
  permissionConfigForProfile,
  resolveLiveRoomMemberPermission,
} from '../src/lib/live-room-permissions';

assert.equal(formatLiveRoomPermissionLabel(JSON.stringify(permissionConfigForProfile('full_access'))), 'Full Access');
assert.equal(formatLiveRoomPermissionLabel(null), 'Dev Local');

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
assert.equal(resolveLiveRoomMemberPermission('{bad json', null).profile, 'dev_local');

assert.deepEqual(DEFAULT_ACPX_PERMISSION_CONFIG, permissionConfigForProfile('dev_local'));
for (const value of [null, undefined, {}]) {
  assert.deepEqual(normalizeAcpxPermissionConfig(value), permissionConfigForProfile('dev_local'));
}
const safe = permissionConfigForProfile('safe_local', ['/workspace']);
assert.equal(safe.networkAccess, 'restricted');
assert.deepEqual(normalizeAcpxPermissionConfig(safe), safe);
assert.deepEqual(resolveLiveRoomMemberPermission(JSON.stringify(safe), JSON.stringify(member)), safe);
