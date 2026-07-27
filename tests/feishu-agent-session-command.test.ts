import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { harnessCommandMatches, interruptPersistedHarness } from '../src/lib/live-room-interrupt';
import type { ParsedFeishuMessage } from '../src/lib/feishu-message-content';

const message = (text: string): ParsedFeishuMessage => ({
  text,
  messageType: 'text',
  mentions: [],
  mentionNames: [],
  chatType: 'p2p',
  chatId: 'chat',
  messageId: 'message',
  senderOpenId: 'user',
});

assert.deepEqual(parseFeishuCommand(message('/ap stop')), {
  command: 'stop',
  args: [],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap stop codex')), {
  command: 'stop',
  args: ['codex'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap sessions')), {
  command: 'sessions',
  args: [],
  options: {},
});
assert.equal(harnessCommandMatches('node /home/hello/.local/bin/codex app-server', 'codex'), true);
assert.equal(harnessCommandMatches('node unrelated-server', 'codex'), false);

void (async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex-test-harness']);
  assert.ok(child.pid);
  assert.equal(await interruptPersistedHarness(JSON.stringify({ childPid: child.pid }), 'codex', 'SIGKILL'), true);
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.throws(() => process.kill(child.pid!, 0));
  console.log('Feishu Agent session command checks passed');
})();
