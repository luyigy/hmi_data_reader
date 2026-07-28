import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';

const message = (text: string) => ({
  chatId: 'chat', chatType: 'p2p' as const, messageId: 'message', senderOpenId: 'user',
  messageType: 'text' as const, text, mentions: [], mentionNames: [],
});

assert.deepEqual(parseFeishuCommand(message('/ap plan --host=codex design login')), {
  command: 'plan', args: ['design', 'login'], options: { host: 'codex' },
});

console.log('Feishu plan command checks passed');
