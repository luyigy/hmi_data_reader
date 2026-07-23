import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFeishuCommand } from '../src/lib/feishu';
import { handleFeishuUserManagementCommand } from '../src/lib/feishu-access-approval';
import { prisma } from '../src/lib/prisma';

const message = (text: string) => ({
  chatId: 'chat', chatType: 'p2p', messageId: 'message', senderOpenId: 'user',
  messageType: 'text', text, mentions: [], mentionNames: [],
});

assert.deepEqual(parseFeishuCommand(message('/ap users --status=blocked')), {
  command: 'users', args: [], options: { status: 'blocked' },
});
assert.deepEqual(parseFeishuCommand(message('/ap user unblock ou_123')), {
  command: 'user', args: ['unblock', 'ou_123'], options: {},
});

process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
void handleFeishuUserManagementCommand({
    command: { command: 'users', args: [], options: {} }, senderOpenId: 'not-admin',
  }).then((result) => assert.match(result, /仅配置的 Feishu 管理员/));

void (async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ap-user-workspace-'));
  let bindingWhere: unknown;
  let roomUpdate: unknown;
  let taskUpdate: unknown;

  Object.assign(prisma.feishuUserAccess, {
    findUnique: async () => ({ openId: 'ou_legacy', chatId: 'oc_legacy', displayName: 'Legacy User' }),
    update: async () => ({}),
  });
  Object.assign(prisma.feishuConversationBinding, {
    findMany: async ({ where }: { where: unknown }) => {
      bindingWhere = where;
      return [{ liveRoomId: 'room_legacy' }];
    },
  });
  Object.assign(prisma.liveRoom, {
    findUnique: async () => ({ workingDirectory: '/old/workspace', sourceTaskId: 'task_legacy', members: [] }),
    update: async (args: unknown) => { roomUpdate = args; return {}; },
  });
  Object.assign(prisma.task, {
    update: async (args: unknown) => { taskUpdate = args; return {}; },
  });

  const result = await handleFeishuUserManagementCommand({
    command: { command: 'user', args: ['workspace', 'ou_legacy', workspaceRoot], options: {} },
    senderOpenId: 'admin',
  });

  assert.deepEqual(bindingWhere, { OR: [
    { senderOpenId: 'ou_legacy' },
    { chatId: 'oc_legacy', chatType: 'p2p' },
  ] });
  assert.deepEqual(roomUpdate, { where: { id: 'room_legacy' }, data: { workingDirectory: workspaceRoot } });
  assert.deepEqual(taskUpdate, {
    where: { id: 'task_legacy' },
    data: {
      workingDirectory: workspaceRoot,
      acpxPermissionConfig: JSON.stringify({
        profile: 'safe_local', sandboxMode: 'workspace-write', networkAccess: 'enabled',
        approvalPolicy: 'never', writableRoots: [workspaceRoot],
      }),
    },
  });
  assert.match(result, /授权根目录已更新/);
})();
