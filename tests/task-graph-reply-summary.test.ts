import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
const base = { id: 'fixture', status: 'completed' as const, error: null, participants: [] };
const report = '已定位到浏览器启动参数问题。\n\n修正后正在运行对应测试。\n\nTASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"新版 OCR 已实现","evidence":["report.md"]}';
const card = buildRunReplyCard({ ...base, summary: report }, []);
assert.match(JSON.stringify(card.body.elements[0]), /已定位到浏览器启动参数问题.*修正后正在运行对应测试/);
assert.doesNotMatch(JSON.stringify(card.body.elements[0]), /TASK_GRAPH_IMPLEMENTATION|当前阶段|下一自动动作|剩余额度/);
assert.deepEqual(buildRunReplyCard({ ...base, summary: report, graphStatus: 'verifying' }, []), card);
assert.deepEqual(buildRunReplyCard({ ...base, summary: report, graphStatus: 'passed' }, []), card);
const long = buildRunReplyCard({ ...base, summary: '开头答复\n' + '中文😀\n'.repeat(9000) + '最终答复' }, []);
assert.match(JSON.stringify(long.body.elements[0]), /最终答复/);
assert.match(JSON.stringify(long.body.elements[0]), /前文超出卡片容量/);
assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(long))) < 28000);
const blocked = buildRunReplyCard({ ...base, summary: '正在查原因\nTASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"permission_required","note":"请批准读取指定目录"}' }, []);
assert.match(JSON.stringify(blocked.body.elements[0]), /请批准读取指定目录/);
const failed = buildRunReplyCard({ ...base, status: 'failed', summary: '已读取文件', error: '浏览器启动失败 ECONNREFUSED' }, []);
assert.match(JSON.stringify(failed.body.elements.filter(e => e.tag === 'markdown')), /已读取文件.*ECONNREFUSED/);
const answer = '补 1 张可以。\n\n你这张是伯乐三段“熔胶”页，不能作为白色五段页的独立验收图。\n\n请补一张白色五段“储料射退设定”整屏照片。';
const conversation = { ...base, replyKind: 'conversation', summary: answer, graphStatus: 'attention', graphProgress: {
  ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: '旧阻塞：缺独立验收图。' },
} } satisfies Parameters<typeof buildRunReplyCard>[0];
const reply = buildRunReplyCard(conversation, []);
assert.match(JSON.stringify(reply.body.elements[0]), /补 1 张可以.*你这张是伯乐三段.*请补一张白色五段/);
assert.doesNotMatch(JSON.stringify(reply.body.elements[0]), /旧阻塞|请确认这项请求|TASK_GRAPH_/);
assert.match(reply.header.title.content, /本轮已答复/);
assert.doesNotMatch(JSON.stringify(reply), /旧阻塞|任务交付状态/);
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

const review = buildRunReplyCard({ ...base, summary: 'TASK_GRAPH_REVIEW {"approved":true,"note":"固定版本12项通过，仅限已批准的局部草稿链路"}' }, []);
assert.match(JSON.stringify(review.body.elements[0]), /固定版本12项通过/);
assert.doesNotMatch(JSON.stringify(review.body.elements[0]), /TASK_GRAPH_REVIEW|approved/);

const progressChunks = [
  { content: '我会先核对固定版本。\n\n' },
  { content: '资料查询返回5条，正在下载4张图。\n\n' },
  { content: '4张图均命中旧输入，正在整理证据。\n\n' },
];
const finalReview = 'TASK_GRAPH_REVIEW {"approved":false,"note":"原有通过项保留，尚缺独立样本。"}';
const visibleText = (card: ReturnType<typeof buildRunReplyCard>) => card.body.elements.filter(e => e.tag === 'markdown').map(e => 'content' in e ? e.content : '').join('\n');
for (let count = 1; count <= progressChunks.length; count++) {
  const activeCard = buildRunReplyCard({ ...base, status: 'running', summary: null }, [], [], progressChunks.slice(0, count));
  assert.ok(visibleText(activeCard).includes(progressChunks[count - 1].content.trim()), 'Each incremental update shows the latest Agent words');
}
const finishedStream = buildRunReplyCard({ ...base, summary: finalReview }, [], [], [...progressChunks, { content: finalReview }]);
for (const chunk of progressChunks) assert.ok(visibleText(finishedStream).includes(chunk.content.trim()), 'Finalizing must retain every streamed progress message');
assert.equal(visibleText(finishedStream).split('原有通过项保留，尚缺独立样本。').length - 1, 1, 'Final note must not be duplicated');
const summaryOnlyFinal = buildRunReplyCard({ ...base, summary: '处理完了，请确认图片来源。' }, [], [], progressChunks);
assert.ok(visibleText(summaryOnlyFinal).includes(progressChunks[0].content.trim()));
assert.match(visibleText(summaryOnlyFinal), /处理完了，请确认图片来源/);
const longProgress = [{ content: '早期过程'.repeat(6000) }, { content: '\n\n最新进度：正在核对第四张图。' }];
const advancing = buildRunReplyCard({ ...base, status: 'running', summary: null }, [], [], longProgress);
assert.match(visibleText(advancing), /最新进度：正在核对第四张图/, 'A full card must still show newly streamed output');

const noNewlines = [
  { sequence: 3, content: '先核对版本。' },
  { sequence: 9, content: '已经找到原始证据。' },
  { sequence: 14, content: finalReview },
];
const separated = visibleText(buildRunReplyCard({ ...base, summary: finalReview }, [], [], noNewlines));
assert.match(separated, /先核对版本。\n\n已经找到原始证据。/);
assert.doesNotMatch(separated, /TASK_GRAPH_REVIEW|approved/);
assert.equal(separated.split('原有通过项保留，尚缺独立样本。').length - 1, 1);
const tokens = [{ sequence: 1, content: '正在核' }, { sequence: 2, content: '对图片。' }, { sequence: 3, content: finalReview }];
const tokenReply = visibleText(buildRunReplyCard({ ...base, summary: finalReview }, [], [], tokens));
assert.match(tokenReply, /正在核对图片。/);
assert.doesNotMatch(tokenReply, /TASK_GRAPH_REVIEW|approved/);
