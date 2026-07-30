import assert from 'node:assert/strict';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  buildFeishuCommandCenterCard,
  buildFeishuCommandCenterCardUpdate,
  buildFeishuCommandCenterCards,
  buildFeishuCommandFromForm,
  buildFeishuCommandResultCard,
  FEISHU_COMMAND_CARD_ACTIONS,
  formatFeishuHelp,
} from '../src/lib/feishu-help';

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
assert.equal(parseFeishuCommand(message('ap status')), null);
assert.equal(parseFeishuCommand(message('Workflow Dashboard 点击后没有反馈')), null);
assert.deepEqual(parseFeishuCommand(message('/ap menu')), { command: 'menu', args: [], options: {} });

const cards = buildFeishuCommandCenterCards('group');
assert.equal(cards.length, 1);
assert.ok(cards.every((card) => card.schema === '2.0'));
assert.match(JSON.stringify(cards), /AP 命令中心/);
assert.match(JSON.stringify(cards), /选择一个分类/);
assert.doesNotMatch(JSON.stringify(cards), /\/ap status/);

const workflowCard = buildFeishuCommandCenterCard('group', 'workflow');
for (const command of Array.from(FEISHU_COMMAND_CARD_ACTIONS)) {
  const expectedCategory = command === '/ap members'
    ? 'room'
    : ['/ap status', '/ap gateways', '/ap agents', '/ap hosts', '/ap sessions'].includes(command)
      ? 'runtime'
      : ['/ap dashboard', '/ap jobs', '/ap workflow policy show', '/ap job diagnose workflow-watcher'].includes(command)
        ? 'workflow'
        : 'admin';
  assert.match(
    JSON.stringify(buildFeishuCommandCenterCard('group', expectedCategory)),
    new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
}
assert.match(JSON.stringify(workflowCard), /修改调度/);
const scheduleFormCard = buildFeishuCommandCenterCard('group', 'form-schedule');
assert.match(JSON.stringify(scheduleFormCard), /form_action_type/);
assert.match(JSON.stringify(scheduleFormCard), /submitSchedule_group/);
const scheduleForm = scheduleFormCard.body.elements[0] as {
  elements: Array<Record<string, unknown>>;
};
assert.equal('value' in scheduleForm.elements.at(-1)!, false);
const workflowUpdate = buildFeishuCommandCenterCardUpdate('group', 'workflow');
assert.equal(workflowUpdate.type, 'raw');
assert.deepEqual(workflowUpdate.data, workflowCard);
assert.deepEqual(buildFeishuCommandFromForm('form-workspace', { path: ' projects/hmi ' }), {
  command: 'workspace',
  args: ['projects/hmi'],
  options: {},
});
assert.deepEqual(buildFeishuCommandFromForm('form-chat', { message: ' 请检查数据 ' }), {
  command: 'chat',
  args: ['请检查数据'],
  options: {},
});
assert.deepEqual(buildFeishuCommandFromForm('form-plan', { requirements: ' 做一个薄切片 ' }), {
  command: 'plan',
  args: ['做一个薄切片'],
  options: {},
});
assert.deepEqual(buildFeishuCommandFromForm('form-schedule', {
  jobId: 'workflow-watcher',
  cron: '*/5 * * * *',
}), {
  command: 'job',
  args: ['schedule', 'workflow-watcher'],
  options: { cron: '*/5 * * * *' },
});
assert.equal(buildFeishuCommandFromForm('form-workspace', { path: '  ' }), null);
const resultCard = buildFeishuCommandResultCard('/ap status', 'Agent Platform 状态\n网关：1/1 在线', 'group');
assert.match(JSON.stringify(resultCard), /Agent Platform 状态/);
assert.match(JSON.stringify(resultCard), /查看详细信息/);
assert.match(JSON.stringify(resultCard), /返回命令中心/);

console.log('Feishu help command checks passed');
