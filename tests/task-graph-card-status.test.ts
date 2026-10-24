import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
const base = { id: 'fixture', status: 'completed', summary: '原始记录', error: null, participants: [] };
for (const graphStatus of ['passed', 'awaiting_human', 'attention', 'verifying', 'claimed']) {
  const card = buildRunReplyCard({ ...base, graphStatus, graphProgress: {
    ...initialExecutionProgress(), phase: 'acceptance', state: 'waiting_decision', lastFailure: { code: 'blocked_require_human', detail: '旧故障' },
  } }, []);
  assert.equal(card.header.template, 'grey');
  assert.match(card.header.title.content, /本轮已结束/);
  assert.doesNotMatch(JSON.stringify(card), /验收中|已验收|旧故障/);
}
assert.equal(buildRunReplyCard({ ...base, status: 'running' }, []).header.template, 'blue');
assert.equal(buildRunReplyCard({ ...base, status: 'waiting_for_input' }, []).header.template, 'yellow');
assert.equal(buildRunReplyCard({ ...base, status: 'failed' }, []).header.template, 'red');
console.log('Run status is independent of the Ticket; Ticket decisions remain on the entry card');

import { buildGraphNodeCard } from '../src/lib/task-graph/node-card';
const question = { ...initialExecutionProgress(), state: 'waiting_for_user', waitingKind: 'question', waitingMessage: '请补充独立图片来源' } as const;
const node = { key: 'R6', status: 'attention', evidence: null, executions: [{ key: 'reader', dispatchMetadata: { progress: question } }] };
assert.equal(buildGraphNodeCard(node).header.template, 'yellow');
assert.match(JSON.stringify(buildGraphNodeCard(node)), /请补充独立图片来源/);
const verified = buildGraphNodeCard({ ...node, status: 'passed' });
assert.equal(verified.header.template, 'green');
assert.doesNotMatch(JSON.stringify(verified), /请补充独立图片来源/, 'Passed cards must not retain stale blockers');
const rejected = buildGraphNodeCard({ ...node, evidence: { summary: '正式验收：缺独立真值' }, executions: [{ key: 'reader', dispatchMetadata: { progress: {
  ...initialExecutionProgress(), phase: 'acceptance', state: 'waiting_decision', lastFailure: { code: 'blocked_require_human', detail: 'conditions_unchanged' },
} } }] });
assert.equal(rejected.header.template, 'red');
assert.match(JSON.stringify(rejected), /正式验收：缺独立真值/);
assert.doesNotMatch(JSON.stringify(rejected), /conditions_unchanged/);
assert.match(buildGraphNodeCard({ ...node, status: 'delivered_unverified' }).header.title.content, /未独立验收/);
