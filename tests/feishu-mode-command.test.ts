import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu';

const parsed = parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap mode hybrid',
  mentions: [],
  mentionNames: [],
});

assert.deepEqual(parsed, {
  command: 'mode',
  args: ['hybrid'],
  options: {},
});
