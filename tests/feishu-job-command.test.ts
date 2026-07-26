import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { handleScheduledJobCommand } from '../src/lib/feishu-scheduled-jobs';

const message = (text: string) => ({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text' as const,
  text,
  mentions: [],
  mentionNames: [],
});

assert.deepEqual(parseFeishuCommand(message('/ap jobs')), {
  command: 'jobs',
  args: [],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job disable workflow-watcher')), {
  command: 'job',
  args: ['disable', 'workflow-watcher'],
  options: {},
});
handleScheduledJobCommand({ command: 'jobs', args: [], options: {} }).then((response) => {
  assert.equal(response, '当前 job 命令需要来自 Feishu webhook 的会话上下文。');
});
