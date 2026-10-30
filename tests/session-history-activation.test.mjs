import assert from 'node:assert/strict';
import { waitForHistoryIdle } from '../scripts/enable-session-history-when-idle.mjs';
let elapsed = 0;
let reports = 0;
let idleChecks = 0;
await waitForHistoryIdle(
  async () => elapsed <= 21 * 60000 || idleChecks++ === 1
    ? { runs: 1, jobs: 0, deliveries: 1 }
    : { runs: 0, jobs: 0, deliveries: 0 },
  async () => { reports++; },
  async ms => { elapsed += ms; },
);
assert.ok(elapsed > 21 * 60000, 'still waits after the old 20-minute timeout');
assert.ok(reports > 240, 'keeps publishing waiting status');
assert.equal(idleChecks, 4, 'a new task between the two idle checks prevents activation');
await assert.rejects(waitForHistoryIdle(async () => { throw new Error('database unavailable'); }, async () => {}), /database unavailable/);
console.log('Activation: waits beyond 20 minutes, reports progress, rechecks idle and propagates failures.');
