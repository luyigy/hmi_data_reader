import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { formatFeishuHelp } from '../src/lib/feishu-help';

const message = (text: string) => ({
  chatId: 'chat', chatType: 'p2p' as const, messageId: 'message', senderOpenId: 'user',
  messageType: 'text' as const, text, mentions: [], mentionNames: [],
});

const page2 = parseFeishuCommand(message('/ap help 2'))!;
assert.deepEqual(page2, { command: 'help', args: ['2'], options: {} });
assert.match(formatFeishuHelp(page2), /运行控制[\s\S]*\/ap run[\s\S]*第 2\/4 页[\s\S]*\/ap help 1[\s\S]*\/ap help 3/);

const page3 = parseFeishuCommand(message('/ap help --page=3'))!;
assert.deepEqual(page3, { command: 'help', args: [], options: { page: '3' } });
assert.match(formatFeishuHelp(page3), /Workflow \/ Jobs[\s\S]*diagnose workflow-watcher/);

assert.match(formatFeishuHelp({ args: [], options: {} }), /房间与 Agent[\s\S]*\/ap room[\s\S]*第 1\/4 页/);
assert.deepEqual(parseFeishuCommand(message('/ap handoff-limit 0')), {
  command: 'handoff-limit',
  args: ['0'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap room --handoff-limit=4 demo')), {
  command: 'room',
  args: ['demo'],
  options: { 'handoff-limit': '4' },
});
assert.match(formatFeishuHelp({ args: [], options: {} }), /\/ap handoff-limit \[0-32\]/);
assert.equal(formatFeishuHelp({ args: ['0'], options: {} }), '页码无效：0。请使用 /ap help 1-4。');
assert.equal(formatFeishuHelp({ args: [], options: { page: '5' } }), '页码无效：5。请使用 /ap help 1-4。');

console.log('Feishu help command checks passed');
