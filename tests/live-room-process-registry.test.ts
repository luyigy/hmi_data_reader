import assert from 'node:assert/strict';
import {
  enqueueLiveRoomMemberExecution,
  hasLiveRoomMemberExecution,
} from '../src/lib/live-room-process-registry';

void (async () => {
  const memberId = 'queue-test-member';
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueueLiveRoomMemberExecution(memberId, async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = enqueueLiveRoomMemberExecution(memberId, async () => {
    order.push('second:start');
  });

  assert.equal(hasLiveRoomMemberExecution(memberId), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  assert.equal(hasLiveRoomMemberExecution(memberId), false);
})();
