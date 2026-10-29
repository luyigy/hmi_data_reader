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
