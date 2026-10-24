import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { buildGraphNodeCard } from '../src/lib/task-graph/node-card';
import { formatGraphFailureSummary } from '../src/lib/task-graph/failure-summary';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { formatExecutionProgress } from '../src/lib/task-graph/progress-summary';

for (const [phase, label] of [['prepare', '准备'], ['implement', '实施'], ['collect_result', '补收结果'], ['check', '平台检查'], ['integrate', '集成'], ['architecture', '架构复核'], ['acceptance', '验收']] as const) {
  assert.match(formatExecutionProgress({ ...initialExecutionProgress(), phase }, false), new RegExp(`当前阶段：${label}`));
}
const retry = formatExecutionProgress({ ...initialExecutionProgress(), state: 'ready', phase: 'check', platformAttempts: 1, nextRetryAt: '2026-10-19T00:00:00Z' }, false);
assert.match(retry, /协调器自动领取/); assert.match(retry, /环境重试 1/); assert.match(retry, /最早 2026-10-19T00:00:00Z/);
assert.match(formatExecutionProgress({ ...initialExecutionProgress(), state: 'exhausted' }, false), /自动推进已暂停/);
assert.match(formatExecutionProgress(initialExecutionProgress(), true), /当前阶段：已验收/);
const recovered = buildRunReplyCard({ id: 'recovered', status: 'running', summary: '', error: null, participants: [], graphProgress: {
  ...initialExecutionProgress(), phase: 'acceptance', lastFailure: { code: 'test_failed', detail: '此前的检查缺陷已修复，保留历史记录。' },
} }, []);
assert.doesNotMatch(JSON.stringify(recovered.body.elements[0]), /此前的检查缺陷/);
assert.doesNotMatch(JSON.stringify(recovered), /此前的检查缺陷/);

const failure = { code: 'integration_conflict', detail: JSON.stringify({ message: 'Merge failed', integration: { paths: ['backend/app/contract.py', 'frontend/src/Main.vue'], candidateCommit: 'a'.repeat(40), integrationCommit: 'b'.repeat(40), mergeHead: 'c'.repeat(40) } }) };
const entry = (lastFailure: Parameters<typeof formatGraphFailureSummary>[0], state: 'waiting_decision' | 'exhausted' = 'waiting_decision') => buildGraphNodeCard({
  key: 'N', status: 'attention', evidence: null,
  executions: [{ key: 'repo', dispatchMetadata: { progress: { ...initialExecutionProgress(), state, lastFailure } } }],
});
const card = entry(failure);
const visible = JSON.stringify(card.body.elements[0]);
assert.match(visible, /backend\/app\/contract.py/); assert.match(visible, /下一步：/); assert.match(visible, /负责人：平台/); assert.match(visible, /需要你决定：否/);
assert.doesNotMatch(visible, /Merge failed|candidateCommit|integrationCommit|mergeHead|"paths"/);
assert.match(JSON.stringify(card.body.elements.filter(e => e.tag === 'collapsible_panel')), /candidateCommit/);
assert.match(card.header.title.content, /待处理/);
const scope = entry({ code: 'scope_change', detail: '本票需新增伯乐科巴控制器页面，超出原批准范围，请确认是否纳入。' });
assert.match(JSON.stringify(scope), /伯乐科巴/); assert.match(scope.header.title.content, /待你确认/);
const material = entry({ code: 'missing_business_material', detail: '缺少阿博格冷却页面原图，请提供这张原图后核验。' });
assert.match(JSON.stringify(material), /阿博格冷却页面/);
const explicit = entry({ ...failure, action: '请选择是否保留新增机型的接口范围', owner: 'user', requiresUserDecision: true });
assert.match(explicit.header.title.content, /待你确认/); assert.match(JSON.stringify(explicit), /请选择是否保留新增机型/);
const exhausted = entry({ code: 'test_failed', detail: '相同检查再次失败。' }, 'exhausted');
assert.match(JSON.stringify(exhausted), /本轮自动尝试已停止/);
const upstream = entry({ code: 'missing_upstream_input', detail: '固定Reader包缺少控制器身份。' });
assert.match(JSON.stringify(upstream), /核对前置集成提交、合同版本与固定包/);
console.log('Ticket failures and actionable decisions remain visible on the entry card; old run replies remain stable');
