import assert from 'node:assert/strict';

async function main() {
  let status = 'pending';
  let output = '完成，交给下一位。 $txpi';
  let handoffPending = false;
  let failReply = false;
  const observations: string[] = [];
  const member = { id: 'codex', displayName: 'Codex', harnessType: 'codex', backend: 'platform_local',
    memberType: 'local_agent', joinStatus: 'joined', presenceStatus: 'online', canReply: true };
  const room = { id: 'room', members: [member, { ...member, id: 'txpi', displayName: 'txpi', harnessType: 'pi-agent' }] };
  const source = { id: 'source', content: '实施后交给txpi验证', metadata: null };
  const row = () => ({ id: 'delivery', deliveryStatus: status, handoffRootMessageId: 'root' });
  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: unknown };
  prismaModule.prisma = {
    liveRoom: { findUnique: async () => room },
    liveRoomMessage: { findUnique: async () => source },
    liveRoomDelivery: {
      findUnique: async () => row(),
      update: async ({ data }: { data: { deliveryStatus: string } }) => { status = data.deliveryStatus; return row(); },
      updateMany: async ({ where, data }: { where: { deliveryStatus: string }; data: { deliveryStatus: string } }) => {
        if (where.deliveryStatus !== status) return { count: 0 };
        status = data.deliveryStatus;
        return { count: 1 };
      },
    },
    liveRoomMember: { update: async () => member },
    liveRoomMemberSession: { update: async () => ({}) },
  };
  const routing = await import('../src/lib/live-room-delivery-routing') as unknown as Record<string, unknown>;
  routing.ensureMemberSession = async () => ({ id: 'session', threadId: 'thread', status: 'online' });
  const execution = await import('../src/lib/live-room-delivery-execution') as unknown as Record<string, unknown>;
  execution.executeLiveRoomReplyViaAcpx = async () => ({ output, threadId: 'thread' });
  const graph = await import('../src/lib/task-graph/conversation-intent') as unknown as Record<string, unknown>;
  graph.applyGraphControlOutput = async ({ output }: { output: string }) => output;
  const cards = await import('../src/lib/feishu-turn-card') as unknown as Record<string, unknown>;
  cards.failRoomTurnCard = async () => false;
  const messages = await import('../src/lib/live-room-messages') as unknown as Record<string, unknown>;
  messages.postLiveRoomMessage = async ({ messageType }: { messageType: string }) => {
    if (messageType === 'assistant') {
      observations.push(status);
      if (failReply) throw new Error('reply persistence failed');
    }
    return { id: 'assistant' };
  };
  const handoffs = await import('../src/lib/live-room-handoff') as unknown as Record<string, unknown>;
  handoffs.claimLiveRoomHandoff = async () => {
    observations.push(status);
    handoffPending = true;
    return { status: 'accepted', delivery: { id: 'txpi-delivery', deliveryStatus: 'pending', fallbackReason: null } };
  };
  const { processLiveRoomDelivery } = await import('../src/lib/live-room-delivery-processing');
  const run = () => processLiveRoomDelivery({ deliveryId: 'delivery', roomId: 'room', roomMessageId: 'source',
    targetMemberId: 'codex', chainDepth: 0 });

  const handoff = await run();
  assert.deepEqual(observations, ['running', 'running'], 'reply and handoff must persist while source delivery is still busy');
  assert.equal(handoffPending, true, 'deferred enqueue must already have a durable pending txpi delivery');
  assert.ok(handoff);
  assert.equal(status, 'delivered');

  observations.length = 0;
  status = 'pending'; output = '普通回复'; handoffPending = false;
  assert.equal(await run(), null);
  assert.deepEqual(observations, ['running']);
  assert.equal(status, 'delivered');
  assert.equal(handoffPending, false);

  status = 'pending'; failReply = true;
  assert.equal(await run(), null);
  assert.equal(status, 'failed', 'completion must not overwrite failure');
  console.log('Live room reply completion and durable handoff boundary passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
