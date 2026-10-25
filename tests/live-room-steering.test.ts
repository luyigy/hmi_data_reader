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
  const { trySteerLocalMember, dispatchLocalSteeringOnce } = await import('../src/lib/live-room-steering');
  let calls = 0;
  let result: 'accepted' | 'rejected' | 'unknown' = 'accepted';
  const clear = registerLiveRoomSteering('pi','room','session', async () => { calls++; return result; }, 0, 'original');
  const deliver = async (id: string) => {
    rows.set(id, { roomMessageId: id, deliveryStatus: 'pending' });
    return trySteerLocalMember({ deliveryId:id, messageId:id, roomId:'room', memberId:'pi', sessionId:'session',
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
  await Promise.all([dispatchLocalSteeringOnce('dedup','pi',dispatch), dispatchLocalSteeringOnce('dedup','pi',dispatch)]);
  await dispatchLocalSteeringOnce('dedup','pi',dispatch);
  assert.equal(dispatched, 1);
  // Exercise the real delivery entry, with persistence/runner boundaries stubbed.
  const routing = await import('../src/lib/live-room-delivery-routing');
  const processing = await import('../src/lib/live-room-delivery-processing');
  let queued = 0, injected = 0;
  const member = { id:'codex', displayName:'Codex', backend:'platform_local', harnessType:'codex', canReply:true };
  let message = { id:'', content:'输出 hello', messageType:'user', senderMember:{memberType:'user'}, metadata:null as string | null };
  Object.assign(routing, { ensureMemberSession:async()=>({id:'session'}), getPrimaryReplyTarget:()=>member });
  Object.assign(processing, { processLiveRoomDelivery:async()=>{queued++;return null;} });
  Object.assign((prismaModule.prisma as {liveRoomDelivery:object}).liveRoomDelivery, {
    create:async()=>{
      const row={id:message.id,roomMessageId:message.id,deliveryStatus:'pending',createdAt:new Date()};
      rows.set(message.id,row);return row;
    },
  });
  Object.assign(prismaModule.prisma as object, {
    liveRoom:{findUnique:async()=>({id:'room'})},
    liveRoomMessage:{findUnique:async()=>message, findUniqueOrThrow:async()=>({...message, roomId:'room', room:{sourceTaskId:null}})},
    feishuConversationBinding:{findMany:async()=>[]},
  });
  const unregisterCodex=registerLiveRoomSteering('codex','room','session',async id=>{
    assert.equal(rows.get(id)?.deliveryStatus,'running','claim persisted before injection');
    injected++;return 'accepted';
  },0,'codex-original');
  const {triggerLiveRoomAgentReply}=await import('../src/lib/live-room-delivery');
  const trigger=async(id:string, overrides:object={})=>{
    message={...message,id};
    await triggerLiveRoomAgentReply({roomId:'room',roomMessageId:id,allowHandoff:false,...overrides});
  };
  await trigger('codex-normal'); await trigger('codex-normal');
  assert.equal(injected,1);assert.equal(queued,0);
  await trigger('forced',{forceTargetMember:true});
  await trigger('relay',{chainDepth:1});
  message.content='/new';await trigger('slash');message.content='输出 hello';
  message.metadata=JSON.stringify({mentionedAll:true});await trigger('all');
  message.metadata=JSON.stringify({source:'workflow_watcher'});await trigger('workflow');message.metadata=null;
  message.messageType='assistant';await trigger('assistant');message.messageType='user';
  member.backend='gateway_openclaw';await trigger('remote');member.backend='platform_local';
  member.harnessType='claude';await trigger('other-harness');member.harnessType='codex';
  assert.equal(injected,1);assert.equal(queued,8);
  member.harnessType='antigravity';await trigger('antigravity-normal');assert.equal(injected,2);
  assert.match(notices.at(-1)!, /正在中断当前轮并在同一会话/);
  unregisterCodex();await trigger('codex-startup');assert.equal(queued,9);
  console.log('Live Room steering: receipts, fallback, generation/run/session guards, cleanup and dedup passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
