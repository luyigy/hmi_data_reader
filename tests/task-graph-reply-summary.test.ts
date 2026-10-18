import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
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
