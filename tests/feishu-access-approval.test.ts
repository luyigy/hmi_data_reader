import assert from 'node:assert/strict';
import { commandRequestsFullAccess } from '../src/lib/feishu-access-approval';
import { grantRightsForRoom } from '../src/lib/feishu-grant';

assert.equal(commandRequestsFullAccess({ command: 'grant', args: ['full'], options: {} }), true);
assert.equal(commandRequestsFullAccess({ command: 'room', args: [], options: { profile: 'full_access' } }), true);
assert.equal(commandRequestsFullAccess({ command: 'new-session', args: [], options: { rights: 'full-access' } }), true);
assert.equal(commandRequestsFullAccess({ command: 'rights', args: [], options: {} }), true);
assert.equal(commandRequestsFullAccess({ command: 'grant', args: ['dev'], options: {} }), false);

void assert.rejects(
  grantRightsForRoom({ roomId: 'room', profile: 'full_access' }),
  /administrator approval/
);
