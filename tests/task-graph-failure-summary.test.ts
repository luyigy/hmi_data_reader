import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';

const failure = { code: 'integration_conflict', detail: JSON.stringify({ message: 'Merge failed', integration: { paths: ['backend/app/contract.py', 'frontend/src/Main.vue'], candidateCommit: 'a'.repeat(40), integrationCommit: 'b'.repeat(40), mergeHead: 'c'.repeat(40) } }) };
const card = buildRunReplyCard({ id: 'fixture', status: 'completed', summary: 'raw technical summary', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: failure } }, []);
const visible = card.body.elements[0]; assert.ok('content' in visible && typeof visible.content === 'string');
assert.match(visible.content, /backend\/app\/contract.py/); assert.match(visible.content, /下一步：/); assert.match(visible.content, /负责人：平台/); assert.match(visible.content, /需要你决定：否/);
assert.doesNotMatch(visible.content, /Merge failed|candidateCommit|integrationCommit|mergeHead|"paths"/);
const detail = card.body.elements.find(element => element.tag === 'collapsible_panel' && 'header' in element && element.header?.title.content === '当前阶段故障详情'); assert.ok(detail && 'expanded' in detail && detail.expanded === false);
assert.match(JSON.stringify(detail), /candidateCommit/);
console.log('Conflict summary shows files, next action, owner and decision requirement in Chinese; raw Git JSON remains folded');

assert.match(card.header.title.content, /待平台处理/); assert.doesNotMatch(card.header.title.content, /需决定|需你确认/);
const scope = buildRunReplyCard({ id: 'scope', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'scope_change', detail: '本票需新增伯乐科巴控制器页面，超出原批准范围，请确认是否纳入。' } } }, []);
assert.match(JSON.stringify(scope.body.elements[0]), /伯乐科巴/); assert.match(scope.header.title.content, /需你确认/);
const exhausted = buildRunReplyCard({ id: 'exhausted', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'exhausted', lastFailure: { code: 'unknown', detail: '{}' } } }, []);
assert.match(exhausted.header.title.content, /待平台处理/); assert.doesNotMatch(JSON.stringify(exhausted.body.elements[0]), /需要你决定：是/);

const material = buildRunReplyCard({ id: 'material', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: '缺少阿博格冷却页面原图，请提供这张原图后核验。' } } }, []);
assert.match(material.header.title.content, /需你确认/); assert.match(JSON.stringify(material.body.elements[0]), /阿博格冷却页面/); assert.match(JSON.stringify(material.body.elements[0]), /负责人：你/);
const explicitFailure: typeof failure & { action: string; owner: 'user'; requiresUserDecision: boolean } = { ...failure, action: '请选择是否保留新增机型的接口范围', owner: 'user', requiresUserDecision: true };
const explicit = buildRunReplyCard({ id: 'explicit', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'waiting_decision', lastFailure: explicitFailure } }, []);
assert.match(explicit.header.title.content, /需你确认/); assert.match(JSON.stringify(explicit.body.elements[0]), /请选择是否保留新增机型/);

const exhaustedChecks = buildRunReplyCard({ id: 'exhausted-checks', status: 'completed', summary: '', error: null, participants: [], graphStatus: 'attention', graphProgress: { ...initialExecutionProgress(), state: 'exhausted', repairAttempts: 2, lastFailure: { code: 'test_failed', detail: '相同检查再次失败。' } } }, []);
assert.match(exhaustedChecks.header.title.content, /待平台处理/);
const exhaustedBody = JSON.stringify(exhaustedChecks.body.elements[0]);
assert.match(exhaustedBody, /自动处理已耗尽/); assert.match(exhaustedBody, /普通继续不会重置自动处理额度/);
assert.match(exhaustedBody, /负责人：平台/); assert.doesNotMatch(exhaustedBody, /修复失败检查后重新验证|待实施回修/);
