import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
const base = { id: 'fixture', status: 'completed' as const, error: null, participants: [] };
const report = '冗长的技术过程\n\n' + '原始技术日志'.repeat(600) + '\n\nTASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"新版 OCR 识读和离线包已实现，覆盖尚有缺项","evidence":["report.md"]}';
const card = buildRunReplyCard({ ...base, summary: report }, []);
const visible = card.body.elements[0];
assert.ok('content' in visible && typeof visible.content === 'string');
assert.ok(visible.content.length <= 240, 'Collapsed progress must remain short');
assert.match(visible.content, /新版 OCR/);
assert.doesNotMatch(visible.content, /TASK_GRAPH_IMPLEMENTATION|原始技术日志/);
assert.ok(card.body.elements.some(element => element.tag === 'collapsible_panel' && 'expanded' in element && element.expanded === false));
console.log('Main progress is a short delivery note; technical report and machine marker stay outside the main text');

const paused = buildRunReplyCard({ ...base, summary: report, graphStatus: 'attention' }, []);
assert.match(JSON.stringify(paused.body.elements[0]), /任务需处理/);
assert.doesNotMatch(JSON.stringify(paused.body.elements[0]), /实施已提交结果/);

const answer = '补 1 张可以。\n\n你这张是伯乐三段“熔胶”页，不能作为白色五段页的独立验收图。\n\n请补一张白色五段“储料射退设定”整屏照片。';
const conversation = { ...base, replyKind: 'conversation', summary: answer, graphStatus: 'attention', graphProgress: {
  ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: '旧阻塞：缺独立验收图。' },
} } satisfies Parameters<typeof buildRunReplyCard>[0];
const reply = buildRunReplyCard(conversation, []);
assert.match(JSON.stringify(reply.body.elements[0]), /补 1 张可以.*你这张是伯乐三段.*请补一张白色五段/);
assert.doesNotMatch(JSON.stringify(reply.body.elements[0]), /旧阻塞|请确认这项请求|TASK_GRAPH_/);
assert.match(reply.header.title.content, /本轮已答复/);
const taskState = reply.body.elements.find(element => element.tag === 'collapsible_panel' && 'header' in element && element.header.title.content === '任务交付状态');
assert.ok(taskState && 'expanded' in taskState && taskState.expanded === false);
assert.match(JSON.stringify(taskState), /旧阻塞/);
const streaming = buildRunReplyCard({ ...conversation, status: 'running' }, [], [], [{ content: '正在核对你补充的图片。' }]);
assert.match(JSON.stringify(streaming.body.elements[0]), /正在核对你补充的图片/);
assert.doesNotMatch(streaming.header.title.content, /需你确认/);
const failedChat = buildRunReplyCard({ ...conversation, status: 'failed', summary: '', error: '本轮连接失败' }, []);
assert.match(JSON.stringify(failedChat.body.elements[0]), /本轮连接失败/);
assert.match(failedChat.header.title.content, /执行失败/);
const deliveredChat = buildRunReplyCard({ ...conversation, graphStatus: 'passed' }, []);
assert.match(JSON.stringify(deliveredChat.body.elements[0]), /你这张是伯乐三段/);
assert.match(deliveredChat.header.title.content, /本轮已答复/);
const handoffChat = buildRunReplyCard({ ...conversation, summary: answer + '\nTASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["input"]}' }, []);
assert.doesNotMatch(JSON.stringify(handoffChat.body.elements[0]), /TASK_GRAPH_CONVERSATION/);
const controlOnly = buildRunReplyCard({ ...conversation, summary: 'TASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["earlier-image"],"note":"用户已澄清段数，可接着核对控制器和字段。"}' }, []);
assert.match(JSON.stringify(controlOnly.body.elements[0]), /用户已澄清段数/);
assert.doesNotMatch(JSON.stringify(controlOnly.body.elements[0]), /没有文字答复|已恢复|已启动|TASK_GRAPH_CONVERSATION/);
console.log('Conversation answers and live output stay visible; graph delivery state remains separate and unchanged');
