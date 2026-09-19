import assert from 'node:assert/strict';
import {
  registerLiveRoomSteering, steerLiveRoomMember, getLiveRoomSteering,
  cancelQueuedLiveRoomMemberExecutions, getLiveRoomExecutionGeneration,
} from '../src/lib/live-room-process-registry';

async function main() {
  const rows = new Map<string, Record<string, unknown>>();
  const notices: string[] = [];
  let olderQueued = false;
  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: unknown };
  prismaModule.prisma = { liveRoomDelivery: {
    findFirst: async ({ where }: { where: { roomMessageId?: string; deliveryStatus?: string } }) =>
      where.deliveryStatus ? olderQueued ? { id: 'older' } : null : rows.get(where.roomMessageId!),
    updateMany: async ({ where, data }: { where: { id: string; deliveryStatus: string }; data: object }) => {
      const row = rows.get(where.id);
      if (!row || row.deliveryStatus !== where.deliveryStatus) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.get(where.id)!, data),
  } };
  const liveRoom = await import('../src/lib/live-room-messages') as unknown as { postLiveRoomMessage: (args: { content: string }) => Promise<void> };
  liveRoom.postLiveRoomMessage = async ({ content }) => { notices.push(content); };
  const { trySteerLocalPi, dispatchLocalPiOnce } = await import('../src/lib/live-room-steering');
  let calls = 0;
  let result: 'accepted' | 'rejected' | 'unknown' = 'accepted';
  const clear = registerLiveRoomSteering('pi','room','session', async () => { calls++; return result; }, 0, 'original');
  const deliver = async (id: string) => {
    rows.set(id, { roomMessageId: id, deliveryStatus: 'pending' });
    return trySteerLocalPi({ deliveryId:id, messageId:id, roomId:'room', memberId:'pi', sessionId:'session',
      content:'追加', displayName:'Pi', generation:0, relayOrigin:{}, createdAt:new Date() });
  };
  assert.equal(await deliver('accepted'), true);
  assert.equal(rows.get('accepted')!.deliveryStatus, 'delivered');
  assert.match(String(rows.get('accepted')!.fallbackReason), /runMessageId=original/);
  result = 'unknown';
  assert.equal(await deliver('unknown'), true, 'unknown must not fall back to queue');
  assert.equal(rows.get('unknown')!.deliveryStatus, 'failed');
  assert.match(notices.at(-1)!, /未自动重发/);
  result = 'rejected';
  assert.equal(await deliver('rejected'), false, 'explicit rejection may queue');
  assert.equal(rows.get('rejected')!.deliveryStatus, 'pending');
  assert.equal(await steerLiveRoomMember('pi','room','different','m','x'), 'rejected');
  assert.equal(await steerLiveRoomMember('pi','other','session','m','x'), 'rejected');
  assert.equal(await steerLiveRoomMember('pi','room','session','m','x',0,'old-run'), 'rejected');
  assert.equal(calls, 3);
  olderQueued = true;
  assert.equal(await deliver('behind-startup'), false);
  assert.equal(calls, 3, 'later steering must not overtake startup queue');
  olderQueued = false;
  cancelQueuedLiveRoomMemberExecutions('pi');
  assert.equal(await steerLiveRoomMember('pi','room','session','m','x'), 'rejected');
  const freshClear = registerLiveRoomSteering('pi','room','session', async () => { calls++; return 'accepted'; }, getLiveRoomExecutionGeneration('pi'), 'fresh');
  clear();
  assert.ok(getLiveRoomSteering('pi'), 'old cleanup must not clear fresh registration');
  assert.equal(await steerLiveRoomMember('pi','room','session','m','x',0), 'rejected');
  assert.equal(calls, 3, 'old generation must not send into new run');
  freshClear();
  assert.equal(await deliver('startup'), false, 'startup/idle queues normally');
  let dispatched = 0;
  const dispatch = async () => { dispatched++; rows.set('dedup', { deliveryStatus:'delivered' }); };
  await Promise.all([dispatchLocalPiOnce('dedup','pi',dispatch), dispatchLocalPiOnce('dedup','pi',dispatch)]);
  await dispatchLocalPiOnce('dedup','pi',dispatch);
  assert.equal(dispatched, 1);
  console.log('Live Room steering: receipts, fallback, generation/run/session guards, cleanup and dedup passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
