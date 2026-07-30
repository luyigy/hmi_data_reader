import assert from 'node:assert/strict';
import { parseKimiCodeContextUsage } from '../src/lib/real-agents/kimi-code-context';

const stepEnd = (usage?: Record<string, number>) => JSON.stringify({
  type: 'context.append_loop_event',
  event: { type: 'step.end', ...(usage ? { usage } : {}) },
});

const usage = {
  inputCacheRead: 19_200,
  inputCacheCreation: 0,
  inputOther: 9_942,
  output: 963,
};

const firstTurn = [
  '{"type":"metadata","protocol_version":"1.4"}\n',
  '{"type":"config.update","modelAlias":"kimi-code/k3"}\n',
  `${stepEnd(usage)}\n`,
  '{"type":"usage.record","usage":{"inputOther":999999},"usageScope":"turn"}\n',
  '{"type":"future.event","value":1}\n',
].join('');
const splitAt = firstTurn.indexOf('"context.append_loop_event"') + 17;
assert.deepEqual(
  parseKimiCodeContextUsage([firstTurn.slice(0, splitAt), firstTurn.slice(splitAt)]),
  {
    usedTokens: 30_105,
    modelAlias: 'kimi-code/k3',
    protocolVersion: '1.4',
  }
);

assert.deepEqual(parseKimiCodeContextUsage([
  '{"type":"metadata","protocol_version":"1.1"}\n',
  `${stepEnd({ inputCacheRead: 80, inputCacheCreation: 0, inputOther: 15, output: 5 })}\n`,
  `${stepEnd()}\n`,
  '{"type":"context.apply_compaction","tokensBefore":100,"tokensAfter":30}\n',
]), {
  usedTokens: 30,
  protocolVersion: '1.1',
});

assert.deepEqual(parseKimiCodeContextUsage([
  `${stepEnd({ inputCacheRead: 10, inputCacheCreation: 0, inputOther: 2, output: 1 })}\n`,
  '{"type":"context.update_token_count","tokenCount":42,"time":1}\n',
  '{"type":"context.clear","time":0}\n',
]), { usedTokens: 0 });

assert.equal(parseKimiCodeContextUsage([
  stepEnd({ inputCacheRead: 1, inputCacheCreation: 0, inputOther: 2 }),
]), null);
assert.equal(parseKimiCodeContextUsage(['{"type":']), null);
assert.equal(parseKimiCodeContextUsage(['{"type":"usage.record","usage":{"output":1}}']), null);
