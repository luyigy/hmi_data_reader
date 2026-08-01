import assert from 'node:assert/strict';
import { normalizeRepositoryMarkdownPath } from '../src/lib/feishu-document-command';
import { prepareFeishuMarkdown, reuseFeishuDocumentImport } from '../src/lib/feishu-document-import';

assert.equal(
  normalizeRepositoryMarkdownPath('docs/338_HANDOVER_20260731_Test.md'),
  'docs/338_HANDOVER_20260731_Test.md',
);
assert.equal(normalizeRepositoryMarkdownPath('../secret.md'), null);
assert.equal(normalizeRepositoryMarkdownPath('/etc/passwd.md'), null);
assert.equal(normalizeRepositoryMarkdownPath('docs/report.txt'), null);
assert.equal(
  prepareFeishuMarkdown('---\ndoc_type: REPORT\n---\n# Old title\n\nBody\n'),
  'Body\n',
);

async function testIdempotency() {
  let creates = 0;
  assert.equal(await reuseFeishuDocumentImport('same-commit:path', async () => `url-${++creates}`), 'url-1');
  assert.equal(await reuseFeishuDocumentImport('same-commit:path', async () => `url-${++creates}`), 'url-1');
  await assert.rejects(reuseFeishuDocumentImport('retryable', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await reuseFeishuDocumentImport('retryable', async () => `url-${++creates}`), 'url-2');
}

testIdempotency()
  .then(() => console.log('Feishu document command checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
