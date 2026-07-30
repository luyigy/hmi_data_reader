import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { buildFeishuRuntimeRecoveryCommand } from '../src/lib/feishu-long-connection';

const recoveryCommand = buildFeishuRuntimeRecoveryCommand([
  '执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S06：只纯拆分',
  '`docs/303_HANDOVER_20260729_ACPXRunner长文件S05交接.md`、Live Room 服务入口。',
].join('\n'));
assert.equal(
  recoveryCommand,
  '/ap chat 重新执行 docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md 的 S06；严格读取 docs/303_HANDOVER_20260729_ACPXRunner长文件S05交接.md 中的 WORKFLOW_PROMPT 并执行，完成后提交并停止。',
);
assert.equal(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: recoveryCommand,
  mentions: [],
  mentionNames: [],
})?.command, 'chat');
assert.match(buildFeishuRuntimeRecoveryCommand('继续普通任务'), /^\/ap chat 继续执行刚才因服务中断/);

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap add local:kimi\n命令执行失败：旧回复\n/ap agents\n后续说明',
  mentions: [],
  mentionNames: [],
}), {
  command: 'add',
  args: ['local:kimi'],
  options: {},
});

assert.deepEqual(parseFeishuCommand({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text',
  text: '/ap chat 第一行\n第二行',
  mentions: [],
  mentionNames: [],
}), {
  command: 'chat',
  args: ['第一行', '第二行'],
  options: {},
});
