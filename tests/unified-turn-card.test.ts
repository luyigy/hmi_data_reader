import assert from 'node:assert/strict';
import { turnReplyElements } from '../src/lib/agent-reply-card';
import { AgentReplyState } from '../src/lib/agent-reply-state';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';

async function main() {
  const state = new AgentReplyState();
  state.append('早期过程', { id: 'a', phase: 'commentary' });
  state.append('最终', { id: 'b', phase: null });
  state.append('最终答复', { id: 'b', phase: 'final_answer', operation: 'replace' });
  assert.equal(state.view().final, '最终答复');
  assert.equal(state.view().process, '早期过程');
  const tracker = new FeishuProgressTracker('fixture') as any;
  tracker.maybeFlush = async () => {};
  tracker.setFootnotes(['模型：codex-fixture', '输入 123 / 输出 45 tokens']);
  await tracker.setReplyContent('早期过程。'.repeat(200) + '\n\n最新进展。', '', '');
  const running = tracker.buildCard();
  assert.ok(running.elements[0].content.length < 300, 'Running body must stay a compact current preview');
  assert.match(running.elements[0].content, /最新进展/);
  assert.ok(running.elements.some((e: any) => e.tag === 'collapsible_panel' && e.header.title.content === '思考过程'));
  const completed = tracker.buildFinalCard('最终答复。', true);
  assert.equal(completed.elements[0].content, '最终答复。');
  assert.match(JSON.stringify(completed), /123.*45/);

  const base = { id: 'fixture', status: 'completed', summary: '旧的混合 summary', error: null, participants: [] };
  const output = [
    { content: '核对运行状态。', metadata: JSON.stringify({ agentMessage: { id: 'summary:0', phase: 'reasoning_summary' } }) },
    { content: '核对运行状态。', metadata: JSON.stringify({ agentMessage: { id: 'summary:0', phase: 'reasoning_summary', operation: 'replace' } }) },
    { content: '早期过程。', metadata: JSON.stringify({ agentMessage: { id: 'a', phase: 'commentary' } }) },
    { content: '最终答复。', metadata: JSON.stringify({ agentMessage: { id: 'b', phase: 'final_answer' } }) },
  ];
  const graph = buildRunReplyCard(base, [], [], output);
  assert.equal('content' in graph.body.elements[0] ? graph.body.elements[0].content : undefined, '最终答复。');
  assert.ok(graph.body.elements.some(e => e.tag === 'div' && 'text' in e), 'Graph replies also retain telemetry footnotes');
  assert.ok(!graph.body.elements.some(e => e.tag === 'note'), 'Schema 2.0 does not support the legacy note component');
  assert.match(JSON.stringify(graph.body.elements.filter(e => e.tag === 'collapsible_panel')), /早期过程/);
  const processText = JSON.stringify(graph.body.elements.filter(e => e.tag === 'collapsible_panel'));
  assert.equal(processText.split('核对运行状态。').length - 1, 1, 'Graph cards retain public summaries once');
  const huge = '中文😀\"\\\n'.repeat(10000);
  const bounded = { schema: '2.0', body: { elements: turnReplyElements({ schema: '2.0', active: false, latest: '', final: huge, process: huge, tools: huge, footnotes: [huge], details: [{ title: '工作区', text: huge, limit: 2400 }, { title: '运行记录', text: huge, limit: 1200 }] }) } };
  assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(bounded) })) < 30000, 'Combined histories, final answer and footer fit the card request budget');
  console.log('Unified cards: bounded preview, separate public process/final, phase correction and shared footnotes passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
