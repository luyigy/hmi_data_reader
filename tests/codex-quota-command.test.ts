import assert from 'node:assert/strict';
import { handleStatusCommand } from '../src/lib/feishu-runtime-commands';

void (async () => {
  process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  const denied = await handleStatusCommand(
    { command: 'status', args: [], options: { quota: 'true' } },
    {
      chatId: 'chat',
      chatType: 'p2p',
      senderOpenId: 'ordinary-user',
      messageId: 'message',
    },
  );
  assert.equal(denied, '仅配置的 Feishu 管理员可以查看 Codex quota。');
  console.log('codex quota command permission check passed');
})();
