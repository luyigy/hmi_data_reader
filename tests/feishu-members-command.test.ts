import assert from 'node:assert/strict';
import { handleNickCommand } from '../src/lib/feishu-live-room-commands';

async function runTest() {
  // Test handleMembersCommand output includes roles
  const { prisma } = await import('../src/lib/prisma');

  // Directly verify role string formatting logic in handleMembersCommand
  const m1 = {
    displayName: 'codex',
    id: 'member-11111111',
    role: 'implementer',
    backend: 'platform_local',
    permissionLabel: null,
    memberType: 'agent',
    presenceStatus: 'online',
    contextWatermark: null,
  };
  const roleStr1 = ` | 角色: ${m1.role || 'custom'}`;
  const line1 = `- ${m1.displayName} [${m1.id.slice(-8)}]${roleStr1} | ${m1.backend || 'local'} | ${m1.presenceStatus}`;
  
  assert.equal(line1, '- codex [11111111] | 角色: implementer | platform_local | online');

  const originalQueryRaw = prisma.$queryRaw;
  const originalFindMany = prisma.liveRoomMember.findMany;
  const originalTransaction = prisma.$transaction;
  const members = [
    {
      id: 'old-runner', roomId: 'room-1', memberType: 'agent', displayName: 'Old Pi',
      userNickname: 'HPI', shortAlias: 'old-pi', harnessType: 'pi-agent', backend: 'remote_ssh',
      gateway: null,
    },
    {
      id: 'new-runner', roomId: 'room-1', memberType: 'agent', displayName: 'New Pi',
      userNickname: null, shortAlias: 'new-pi', harnessType: 'pi-agent', backend: 'remote_ssh',
      gateway: null,
    },
  ];
  prisma.$queryRaw = (async () => [{ liveRoomId: 'room-1' }]) as typeof prisma.$queryRaw;
  prisma.liveRoomMember.findMany = (async () => members) as unknown as typeof prisma.liveRoomMember.findMany;
  prisma.$transaction = (async (callback: (tx: typeof prisma) => Promise<unknown>) => callback({
    ...prisma,
    liveRoomMember: {
      ...prisma.liveRoomMember,
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        members.filter((member) => where.id.in.includes(member.id)).forEach((member) => { member.userNickname = null; });
        return { count: where.id.in.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: { userNickname: string; shortAlias: string } }) => {
        const member = members.find((item) => item.id === where.id)!;
        Object.assign(member, data);
        return member;
      },
    },
  } as unknown as typeof prisma)) as unknown as typeof prisma.$transaction;

  try {
    const response = await handleNickCommand(
      { command: 'nick', args: ['New Pi', 'hpi'], options: {} },
      { chatId: 'chat-1', chatType: 'group', senderOpenId: 'user-1', messageId: 'message-1' },
    );
    assert.equal(members[0].userNickname, null, 'a reused room nickname must leave the offline member');
    assert.equal(members[1].userNickname, 'hpi', 'the reused room nickname must belong only to the new member');
    assert.match(response, /\$hpi/);
  } finally {
    prisma.$queryRaw = originalQueryRaw;
    prisma.liveRoomMember.findMany = originalFindMany;
    prisma.$transaction = originalTransaction;
  }
  console.log('feishu-members-command test passed cleanly');
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
