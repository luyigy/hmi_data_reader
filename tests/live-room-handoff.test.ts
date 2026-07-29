/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import {
  claimLiveRoomHandoff,
  detectLiveRoomHandoffIntent,
  parseLiveRoomHandoffLimit,
} from '../src/lib/live-room-handoff';
import {
  enqueueLiveRoomMemberExecution,
  hasLiveRoomMemberExecution,
} from '../src/lib/live-room-process-registry';

const members = [
  {
    id: 'a',
    displayName: 'Agent A',
    userNickname: 'A',
    shortAlias: 'a',
    agentNameSnapshot: 'Agent A',
    harnessType: 'codex',
    backend: 'platform_local',
    roleLabel: null,
    gateway: null,
    agentRecord: null,
  },
  {
    id: 'b',
    displayName: 'Agent B',
    userNickname: 'B',
    shortAlias: 'b',
    agentNameSnapshot: 'Agent B',
    harnessType: 'claude',
    backend: 'platform_local',
    roleLabel: null,
    gateway: null,
    agentRecord: null,
  },
];

assert.deepEqual(
  detectLiveRoomHandoffIntent({ content: '$B please continue', members, senderMemberId: 'a' }),
  { kind: 'target', targetMemberId: 'b' },
);
assert.deepEqual(
  detectLiveRoomHandoffIntent({ content: '@B visible only', members, senderMemberId: 'a' }),
  { kind: 'none' },
);
assert.deepEqual(
  detectLiveRoomHandoffIntent({ content: '$B then $A', members }),
  { kind: 'invalid', reason: 'multiple_targets' },
);
assert.deepEqual(
  detectLiveRoomHandoffIntent({ content: '$missing continue', members, senderMemberId: 'a' }),
  { kind: 'invalid', reason: 'unknown_target' },
);
assert.equal(parseLiveRoomHandoffLimit('0'), 0);
assert.equal(parseLiveRoomHandoffLimit('32'), 32);
assert.equal(parseLiveRoomHandoffLimit('-1'), null);
assert.equal(parseLiveRoomHandoffLimit('33'), null);
assert.equal(parseLiveRoomHandoffLimit('1.5'), null);

type MessageState = {
  roomId: string;
  handoffLimitSnapshot: number | null;
  handoffCount: number;
  handoffClaimStatus: string | null;
  handoffRootMessageId?: string | null;
  handoffTargetMemberId?: string | null;
};

const messages = new Map<string, MessageState>([
  ['root', {
    roomId: 'room',
    handoffLimitSnapshot: 2,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['reply-a', {
    roomId: 'room',
    handoffLimitSnapshot: null,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['reply-b', {
    roomId: 'room',
    handoffLimitSnapshot: null,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['reply-over', {
    roomId: 'room',
    handoffLimitSnapshot: null,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['root-off', {
    roomId: 'room',
    handoffLimitSnapshot: 0,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['reply-off', {
    roomId: 'room',
    handoffLimitSnapshot: null,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['root-unavailable', {
    roomId: 'room',
    handoffLimitSnapshot: 4,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
  ['reply-unavailable', {
    roomId: 'room',
    handoffLimitSnapshot: null,
    handoffCount: 0,
    handoffClaimStatus: null,
  }],
]);
const memberState = new Map([
  ['a', { id: 'a', canReply: true, joinStatus: 'joined', presenceStatus: 'online' }],
  ['b', { id: 'b', canReply: true, joinStatus: 'joined', presenceStatus: 'online' }],
]);
const deliveries: Array<Record<string, unknown>> = [];
const tx = {
  liveRoomMessage: {
    updateMany: async ({ where, data }: any) => {
      const message = messages.get(where.id);
      if (!message || (where.roomId && message.roomId !== where.roomId)) return { count: 0 };
      if (where.handoffClaimStatus === null && message.handoffClaimStatus !== null) return { count: 0 };
      if (where.handoffCount?.lt !== undefined && message.handoffCount >= where.handoffCount.lt) {
        return { count: 0 };
      }
      if (data.handoffCount?.increment) message.handoffCount += data.handoffCount.increment;
      if (data.handoffClaimStatus !== undefined) message.handoffClaimStatus = data.handoffClaimStatus;
      if (data.handoffRootMessageId !== undefined) message.handoffRootMessageId = data.handoffRootMessageId;
      if (data.handoffTargetMemberId !== undefined) message.handoffTargetMemberId = data.handoffTargetMemberId;
      return { count: 1 };
    },
    findFirst: async ({ where }: any) => {
      const message = messages.get(where.id);
      return message?.roomId === where.roomId ? message : null;
    },
    update: async ({ where, data }: any) => {
      Object.assign(messages.get(where.id)!, data);
      return messages.get(where.id);
    },
  },
  liveRoomMember: {
    findFirst: async ({ where }: any) => memberState.get(where.id) || null,
  },
  liveRoomDelivery: {
    create: async ({ data }: any) => {
      const delivery = { id: `delivery-${deliveries.length + 1}`, ...data };
      deliveries.push(delivery);
      return delivery;
    },
  },
};

const prismaClient = prisma as any;
const originalTransaction = prismaClient.$transaction;
let transactionTail = Promise.resolve();
prismaClient.$transaction = (callback: (client: typeof tx) => Promise<unknown>) => {
  const run = transactionTail.then(() => callback(tx));
  transactionTail = run.then(() => undefined, () => undefined);
  return run;
};

const run = async () => {
 try {
  const duplicate = await Promise.all([
    claimLiveRoomHandoff({
      assistantMessageId: 'reply-a',
      rootMessageId: 'root',
      targetMemberId: 'b',
      roomId: 'room',
    }),
    claimLiveRoomHandoff({
      assistantMessageId: 'reply-a',
      rootMessageId: 'root',
      targetMemberId: 'b',
      roomId: 'room',
    }),
  ]);
  assert.deepEqual(duplicate.map((result) => result.status).sort(), ['accepted', 'duplicate']);
  assert.equal(messages.get('root')!.handoffCount, 1);
  assert.equal(deliveries.length, 1);

  const backToA = await claimLiveRoomHandoff({
    assistantMessageId: 'reply-b',
    rootMessageId: 'root',
    targetMemberId: 'a',
    roomId: 'room',
  });
  assert.equal(backToA.status, 'accepted');
  assert.equal(messages.get('root')!.handoffCount, 2);
  assert.deepEqual(deliveries.map((delivery) => delivery.targetMemberId), ['b', 'a']);

  const exhausted = await claimLiveRoomHandoff({
    assistantMessageId: 'reply-over',
    rootMessageId: 'root',
    targetMemberId: 'b',
    roomId: 'room',
  });
  assert.equal(exhausted.status, 'rejected_budget_exhausted');
  assert.equal(deliveries.length, 2);

  const disabled = await claimLiveRoomHandoff({
    assistantMessageId: 'reply-off',
    rootMessageId: 'root-off',
    targetMemberId: 'b',
    roomId: 'room',
  });
  assert.equal(disabled.status, 'rejected_disabled');
  assert.equal(messages.get('root-off')!.handoffCount, 0);

  memberState.get('b')!.presenceStatus = 'offline';
  const unavailable = await claimLiveRoomHandoff({
    assistantMessageId: 'reply-unavailable',
    rootMessageId: 'root-unavailable',
    targetMemberId: 'b',
    roomId: 'room',
  });
  assert.equal(unavailable.status, 'accepted');
  assert.equal(unavailable.delivery?.deliveryStatus, 'failed');
  assert.equal(messages.get('root-unavailable')!.handoffCount, 1);
  } finally {
    prismaClient.$transaction = originalTransaction;
  }

  let lockReleasedBeforeHandoff = false;
  await enqueueLiveRoomMemberExecution('a', async () => {
    setImmediate(() => {
      lockReleasedBeforeHandoff = !hasLiveRoomMemberExecution('a');
    });
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lockReleasedBeforeHandoff, true);

  console.log('Live Room handoff checks passed');
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
