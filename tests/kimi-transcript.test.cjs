'use strict';
const assert = require('node:assert/strict');
const { KimiTranscript } = require('../scripts/kimi-session/transcript.cjs');
const events = [];
const transcript = new KimiTranscript(event => events.push(event));
transcript.accept({ type: 'transcript.reset', payload: { agent_id: 'main', seq: 10, snapshot: { items: [{ text: 'OLD_HISTORY' }] } } });
const event = (seq, ops, agent = 'main') => ({ type: 'transcript.ops', payload: { agent_id: agent, seq, ops } });
const first = event(11, [
  { op: 'step.upsert', step: { stepId: 'step1', ordinal: 1 } },
  { op: 'frame.upsert', stepId: 'step1', frame: { frameId: 'think', kind: 'thinking', text: 'PRIVATE' } },
  { op: 'append', target: { type: 'frame', frameId: 'think' }, offset: 7, text: '_REASONING' },
  { op: 'frame.upsert', stepId: 'step1', frame: { frameId: 'comment', kind: 'text', role: 'assistant', text: 'I will inspect' } },
]);
transcript.accept(first); transcript.accept(first); // Duplicate batches must not append twice.
transcript.accept(event(12, [{ op: 'frame.upsert', stepId: 'step1', frame: { frameId: 'foreign', kind: 'text', role: 'assistant', text: 'FOREIGN_AGENT' } }], 'other'));
transcript.accept(event(12, [
  { op: 'frame.upsert', stepId: 'step1', frame: { frameId: 'tool', kind: 'tool', name: 'Agent', toolCallId: 'a', state: 'running', input: { description: 'inspect' } } },
  { op: 'frame.upsert', stepId: 'step1', frame: { frameId: 'tool', kind: 'tool', name: 'Agent', toolCallId: 'a', state: 'done', output: 'done' } },
  { op: 'step.upsert', step: { stepId: 'step2', ordinal: 2 } },
  { op: 'frame.upsert', stepId: 'step2', frame: { frameId: 'answer', kind: 'text', role: 'assistant', text: '' } },
  { op: 'append', target: { type: 'frame', frameId: 'answer' }, offset: 0, text: 'a'.repeat(200) },
]));
assert.equal(transcript.finish(), 'a'.repeat(200));
assert.equal(events.filter(e => e.phase === 'reasoning_summary').length, 1);
assert.equal(events.filter(e => e.phase === 'final_answer').length, 1);
assert.deepEqual(events.filter(e => e.type === 'subagent').map(e => e.info.status), ['running', 'completed']);
assert.doesNotMatch(JSON.stringify(events), /PRIVATE|REASONING|OLD_HISTORY|FOREIGN_AGENT/);
assert.throws(() => transcript.accept(event(14, [])), /gap/);
const limited = new KimiTranscript(() => {});
assert.throws(() => limited.accept(event(1, [{ op: 'frame.upsert', frame: { kind: 'tool', name: 'AgentSwarm', toolCallId: 'too-many', state: 'running', input: { items: [1, 2, 3, 4] } } }])), /limit of 3/);
console.log('Kimi transcript: baseline, dedup, agent scope, thought privacy, final answer, subagents and sequence gaps passed');

const failed = new KimiTranscript(() => {});
failed.accept({ type: 'transcript.reset', payload: { agent_id: 'main', seq: 4, snapshot: { items: [{ kind: 'turn', state: 'failed', error: 'OLD_QUOTA_ERROR' }] } } });
assert.equal(failed.failureMessage(), undefined, 'prior-session errors are not current failures');
failed.accept(event(5, [{ op: 'turn.upsert', turn: { turnId: 't1', state: 'failed', error: 'OTHER_AGENT_ERROR' } }], 'other'));
assert.equal(failed.failureMessage(), undefined, 'subagent failure must not replace the main result');
failed.accept(event(5, [
  { op: 'step.upsert', step: { stepId: 't1.1', turnId: 't1', state: 'interrupted', endReason: 'error', endMessage: '[provider.api_error] 429 quota exhausted' } },
  { op: 'turn.upsert', turn: { turnId: 't1', state: 'failed', error: '429 You have reached your 5-hour usage limit.' } },
]));
assert.match(failed.failureMessage(), /Kimi 额度已耗尽.*429.*5-hour usage limit/);
failed.accept(event(6, [{ op: 'turn.upsert', turn: { turnId: 't2', state: 'failed' } }]));
assert.equal(failed.failureMessage(), undefined, 'a later turn must not inherit an earlier quota error');
failed.accept(event(7, [{ op: 'step.upsert', step: { stepId: 't2.1', turnId: 't2', endReason: 'error', endMessage: '503 Service unavailable' } }]));
assert.match(failed.failureMessage(), /503 Service unavailable/, 'step error is a fallback when turn has no message');
failed.accept(event(8, [{ op: 'turn.upsert', turn: { turnId: 't2', state: 'completed' } }]));
assert.equal(failed.failureMessage(), undefined, 'recovered turns do not keep a previous step error');
failed.accept(event(9, [{ op: 'turn.upsert', turn: { turnId: 't3', state: 'failed', error: '429 Too many requests' } }]));
assert.match(failed.failureMessage(), /^Kimi 执行失败/);
assert.doesNotMatch(failed.failureMessage(), /额度已耗尽/, 'not every 429 means quota exhaustion');
console.log('Kimi failures: current turn reason, step fallback, baseline/subagent isolation and non-quota errors passed');
