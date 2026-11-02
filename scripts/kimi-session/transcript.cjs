'use strict';

// This module sees native frames; only presentation events leave the bridge.
class KimiTranscript {
  constructor(emit) {
    this.emit = emit;
    this.seq = 0;
    this.frames = new Map();
    this.steps = new Map();
    this.turn = undefined;
    this.seenTools = new Set();
    this.thinking = new Set();
    this.subagents = 0;
    this.agentCalls = new Map();
  }

  accept(event) {
    const payload = event.payload;
    if (payload?.agent_id !== 'main') return;
    if (event.type === 'transcript.reset') {
      if (this.seq) throw new Error('Kimi transcript reset during execution; resume the saved session.');
      this.seq = payload.seq;
      return; // The baseline is old history, not output from this invocation.
    }
    if (event.type !== 'transcript.ops') return;
    if (!Number.isInteger(payload.seq)) throw new Error('Invalid Kimi transcript sequence.');
    if (payload.seq <= this.seq) return;
    if (payload.seq !== this.seq + 1) throw new Error('Kimi transcript gap; resume the saved session.');
    this.seq = payload.seq;
    for (const op of payload.ops || []) this.apply(op);
  }

  apply(op) {
    if (op.op === 'turn.upsert') {
      // Retain only failure metadata; a turn also carries the original user prompt.
      this.turn = { id: op.turn.turnId, state: op.turn.state, error: op.turn.error };
    } else if (op.op === 'step.upsert') {
      this.steps.set(op.step.stepId, op.step);
    } else if (op.op === 'frame.upsert') {
      const frame = op.frame;
      if (frame.kind === 'thinking') {
        // Never retain or publish private reasoning text.
        if (!this.thinking.has(frame.frameId)) {
          this.thinking.add(frame.frameId);
          this.emit({ type: 'progress', id: frame.frameId, text: `正在思考（步骤 ${this.steps.get(op.stepId)?.ordinal ?? this.thinking.size}）`, phase: 'reasoning_summary' });
        }
      } else if (frame.kind === 'text' && frame.role === 'assistant') {
        this.frames.set(frame.frameId, { stepId: op.stepId, text: frame.text || '' });
        this.publish(frame.frameId);
      } else if (frame.kind === 'tool') {
        const key = `${frame.toolCallId}:${frame.state}`;
        let input = frame.input;
        if (!input && frame.inputText) { try { input = JSON.parse(frame.inputText); } catch { input = frame.inputText; } }
        if (!this.agentCalls.has(frame.toolCallId) && input && typeof input === 'object' && ['Agent', 'AgentSwarm'].includes(frame.name)) {
          const count = frame.name === 'Agent' ? 1 : (input?.items?.length || 0) + Object.keys(input?.resume_agent_ids || {}).length;
          this.subagents += count;
          if (this.subagents > 3) throw new Error('Kimi Code exceeded the platform limit of 3 SubAgents.');
          const agents = Array.from({ length: count }, (_, index) => ({
            taskId: count === 1 ? frame.toolCallId : `${frame.toolCallId}:${index + 1}`,
            description: input.description || frame.name, status: 'running',
            ordinal: this.subagents - count + index + 1, limit: 3,
          }));
          this.agentCalls.set(frame.toolCallId, agents);
          agents.forEach(info => this.emit({ type: 'subagent', info }));
        }
        if (this.seenTools.has(key)) return;
        this.seenTools.add(key);
        if (frame.state === 'done' || frame.state === 'error') {
          const status = /\bstatus:\s*running\b/i.test(frame.output || '') ? 'running'
            : frame.state === 'error' || /\bstatus:\s*(?:failed|killed|lost)\b/i.test(frame.output || '') ? 'failed' : 'completed';
          this.agentCalls.get(frame.toolCallId)?.forEach(info => this.emit({ type: 'subagent', info: { ...info, status } }));
        }
        this.emit({ type: 'tool', id: frame.toolCallId, failed: frame.state === 'error', name: frame.name, input, completed: frame.state === 'done' || frame.state === 'error' });
      }
    } else if (op.op === 'append' && op.target?.type === 'frame') {
      const frame = this.frames.get(op.target.frameId);
      if (!frame) return; // Includes thinking deltas and non-assistant frames.
      if (op.offset > frame.text.length) throw new Error('Kimi text delta gap.');
      frame.text = frame.text.slice(0, op.offset) + op.text;
      this.publish(op.target.frameId);
    }
  }

  publish(id) {
    const text = this.frames.get(id)?.text;
    if (text) this.emit({ type: 'progress', id, text, phase: 'commentary' });
  }

  failureMessage() {
    const last = [...this.steps.values()].at(-1);
    const error = this.turn?.state === 'failed' && typeof this.turn.error === 'string' && this.turn.error.trim()
      ? this.turn.error
      : (!this.turn || (this.turn.state === 'failed' && last?.turnId === this.turn.id)) && last?.endReason === 'error'
        ? last.endMessage : undefined;
    if (typeof error !== 'string' || !error.trim()) return undefined;
    const label = /\b429\b[\s\S]*\b(?:quota|usage limit)\b/i.test(error) ? 'Kimi 额度已耗尽' : 'Kimi 执行失败';
    return `${label}：${error.trim().slice(0, 2000)}`;
  }

  finish() {
    const last = [...this.steps.values()].at(-1);
    const frames = [...this.frames].filter(([, frame]) => frame.stepId === last?.stepId);
    for (const [id, frame] of frames) this.emit({ type: 'progress', id, text: frame.text, phase: 'final_answer' });
    return frames.map(([, frame]) => frame.text).join('\n');
  }
}
module.exports = { KimiTranscript };
