import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';

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

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap role --member=lcc --role=implementor',
  mentions: [],
  mentionNames: [],
}), {
  command: 'role',
  args: [],
  options: { member: 'lcc', role: 'implementor' },
});

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap restrict all safe',
  mentions: [],
  mentionNames: [],
}), {
  command: 'restrict',
  args: ['all', 'safe'],
  options: {},
});

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap new-session --all',
  mentions: [],
  mentionNames: [],
}), {
  command: 'new-session',
  args: [],
  options: { all: 'true' },
});

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap mode=discussion',
  mentions: [],
  mentionNames: [],
}), {
  command: 'mode',
  args: ['discussion'],
  options: { mode: 'discussion' },
});

