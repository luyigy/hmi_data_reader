import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu';
import { handleFeishuUserManagementCommand } from '../src/lib/feishu-access-approval';

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
