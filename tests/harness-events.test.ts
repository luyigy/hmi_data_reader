import assert from 'node:assert/strict';
import { createProgressDedupe, sanitizePreview } from '../src/lib/acpx/harness-events';

const workspaceRoot = '/srv/agent-platform';

const sanitized = sanitizePreview({
  path: '/srv/agent-platform/src/lib/private.ts',
  otherPath: '/var/tmp/credentials.txt',
  token: 'plain-token-value',
  authorization: 'Bearer bearer-secret',
  signature: 'signed-value',
  hmac: 'hmac-value',
  content: 'first paragraph\n\nprivate file body',
  command: `deploy --token hidden\n\n${'x'.repeat(100)}`,
  text: 'visible\n\nhidden',
}, { workspaceRoot });

assert.match(sanitized, /src\/lib\/private\.ts/);
assert.match(sanitized, /credentials\.txt/);
assert.doesNotMatch(sanitized, /\/srv\/|\/var\/|plain-token-value|bearer-secret|signed-value|hmac-value|private file body/);
assert.ok(sanitized.length <= 81);
assert.equal(sanitizePreview('https://example.test/api/items', { workspaceRoot }), 'https://example.test/api/items');
assert.equal(sanitizePreview('key=sk-exampleSecret123', { workspaceRoot }), 'key=[REDACTED]');
assert.equal(sanitizePreview({ accessToken: 'plain-token-value' }, { workspaceRoot }), '{"accessToken":"[REDACTED]"}');
assert.doesNotMatch(
  sanitizePreview({ content: 'first paragraph\n\nprivate file body' }, { workspaceRoot }),
  /private file body/,
);

const originalNow = Date.now;
let now = 1_000;
Date.now = () => now;
try {
  const tools = createProgressDedupe({ toolMinMs: 3_000, thinkingMinMs: 8_000 });
  const tool = { kind: 'tool_use' as const, toolName: 'Read', preview: 'package.json' };
  assert.equal(tools.consume(tool), null);
  assert.equal(tools.consume(tool), null);
  assert.equal(tools.consume(tool), null);
  now += 3_000;
  assert.deepEqual(tools.consume(tool), { ...tool, preview: 'package.json ×3' });
  assert.deepEqual(tools.flush(), tool);
  assert.equal(tools.flush(), null);

  const burst = createProgressDedupe({ toolMinMs: 3_000, thinkingMinMs: 8_000 });
  assert.equal(burst.consume(tool), null);
  assert.deepEqual(
    burst.consume({ kind: 'tool_use', toolName: 'Write', preview: 'result.ts' }),
    tool,
  );
  assert.deepEqual(burst.flush(), { kind: 'tool_use', toolName: 'Write', preview: 'result.ts' });

  const thoughts = createProgressDedupe({ toolMinMs: 0, thinkingMinMs: 60_000 });
  const firstThought = { kind: 'thinking' as const, text: 'Inspecting callers' };
  assert.deepEqual(thoughts.consume(firstThought), firstThought);
  assert.equal(thoughts.consume(firstThought), null);
  const laterThought = { kind: 'thinking' as const, text: 'Still inspecting' };
  assert.equal(thoughts.consume(laterThought), null);
  now += 60_000;
  assert.deepEqual(thoughts.consume(laterThought), laterThought);
} finally {
  Date.now = originalNow;
}

const duplicateText = createProgressDedupe({ toolMinMs: 0, thinkingMinMs: 0 });
const assistantText = { kind: 'assistant_text' as const, text: 'done' };
assert.deepEqual(duplicateText.consume(assistantText), assistantText);
assert.equal(duplicateText.consume(assistantText), null);
