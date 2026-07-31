import assert from 'node:assert/strict';
import { normalizeRepositoryMarkdownPath } from '../src/lib/feishu-document-command';
import { prepareFeishuMarkdown } from '../src/lib/feishu-document-import';

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

console.log('Feishu document command checks passed');
