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
