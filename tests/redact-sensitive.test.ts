import assert from 'node:assert/strict';
import { redactSensitiveText, redactSensitiveValue } from '../src/lib/redact-sensitive';

const input = 'DATABASE_URL=postgres://fake-user:EXAMPLE_DB_PASSWORD@db.example/test?token=EXAMPLE_QUERY_TOKEN API_TOKEN=EXAMPLE_API_TOKEN password="EXAMPLE_PASSWORD" Authorization: Bearer EXAMPLE_BEARER_TOKEN';
const redacted = redactSensitiveText(input);
assert.equal(redacted.includes('EXAMPLE_'), false);
assert.match(redacted, /postgres:\/\/\[REDACTED\]@db\.example/);
assert.match(redacted, /API_TOKEN=\[REDACTED\]/);

assert.deepEqual(redactSensitiveValue({ tool: { preview: 'secret=EXAMPLE_TOOL_SECRET' } }), {
  tool: { preview: 'secret=[REDACTED]' },
});
