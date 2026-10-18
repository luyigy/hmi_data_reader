import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';

const failure = { code: 'integration_conflict', detail: JSON.stringify({ message: 'Merge failed', integration: { paths: ['backend/app/contract.py', 'frontend/src/Main.vue'], candidateCommit: 'a'.repeat(40), integrationCommit: 'b'.repeat(40), mergeHead: 'c'.repeat(40) } }) };
const card = buildRunReplyCard({ id: 'fixture', status: 'completed', summary: 'raw technical summary', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: failure } }, []);
const visible = card.body.elements[0]; assert.ok('content' in visible && typeof visible.content === 'string');
assert.match(visible.content, /backend\/app\/contract.py/); assert.match(visible.content, /下一步：/); assert.match(visible.content, /负责人：平台/); assert.match(visible.content, /需要你决定：否/);
assert.doesNotMatch(visible.content, /Merge failed|candidateCommit|integrationCommit|mergeHead|"paths"/);
const detail = card.body.elements.find(element => element.tag === 'collapsible_panel' && 'header' in element && element.header.title.content === '当前阶段故障详情'); assert.ok(detail && 'expanded' in detail && detail.expanded === false);
assert.match(JSON.stringify(detail), /candidateCommit/);
console.log('Conflict summary shows files, next action, owner and decision requirement in Chinese; raw Git JSON remains folded');

assert.match(card.header.title.content, /待平台处理/); assert.doesNotMatch(card.header.title.content, /需决定|需你确认/);
const scope = buildRunReplyCard({ id: 'scope', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'scope_change', detail: '本票需新增伯乐科巴控制器页面，超出原批准范围，请确认是否纳入。' } } }, []);
assert.match(JSON.stringify(scope.body.elements[0]), /伯乐科巴/); assert.match(scope.header.title.content, /需你确认/);
const exhausted = buildRunReplyCard({ id: 'exhausted', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'exhausted', lastFailure: { code: 'unknown', detail: '{}' } } }, []);
assert.match(exhausted.header.title.content, /待平台处理/); assert.doesNotMatch(JSON.stringify(exhausted.body.elements[0]), /需要你决定：是/);
