import assert from 'node:assert/strict';
import {
  cancelQueuedLiveRoomMemberExecutions,
  enqueueLiveRoomMemberExecution,
  hasLiveRoomMemberExecution,
  waitForLiveRoomMemberExecutionStop,
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

  const cancelledOrder: string[] = [];
  let releaseRunning!: () => void;
  const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve; });
  const running = enqueueLiveRoomMemberExecution('cancel-test', async () => {
    cancelledOrder.push('running');
    await runningGate;
  });
  const cancelled = enqueueLiveRoomMemberExecution('cancel-test', async () => {
    cancelledOrder.push('cancelled');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  cancelQueuedLiveRoomMemberExecutions('cancel-test');
  releaseRunning();
  await waitForLiveRoomMemberExecutionStop('cancel-test');
  await Promise.all([running, cancelled]);
  assert.deepEqual(cancelledOrder, ['running'], 'cancelled queued delivery must not execute later');

  let releaseQueued!: () => void;
  let completed = false;
  const queuedGate = new Promise<void>((resolve) => {
    releaseQueued = () => {
      completed = true;
      resolve();
    };
  });

  await enqueueLiveRoomMemberExecution('queue-only', () => queuedGate, false);
  assert.equal(completed, false, 'queue-only delivery must return before agent completion');
  releaseQueued();
  console.log('live room queue-return checks passed');
})();
