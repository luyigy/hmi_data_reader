import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

// Execute the runner's real configuration and loopback guard without starting a database.
// The full runner and phase injection are separately covered by the sandbox regression.
const source = fs.readFileSync(new URL('../scripts/test-task-graph-postgres.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const fromFile =');
const end = source.indexOf('const schema =', start);
assert(start >= 0 && end > start, 'Runner configuration section must exist');
const configuration = new vm.Script(source.slice(start, end) + '\nurl.toString();');
const explicit = 'postgresql://postgres:test@127.0.0.1:54321/explicit';
const fallback = 'postgresql://postgres:test@localhost:54322/fallback';

function fixture(t, { file, mode = 0o600, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, '.env');
  if (file !== undefined) fs.writeFileSync(filename, file, { mode });
  const reads = [];
  return {
    filename, reads,
    evaluate: () => configuration.runInNewContext({
      URL, process: { env },
      existsSync: name => fs.existsSync(path.join(root, name)),
      readFileSync: (name, encoding) => {
        reads.push(name);
        return fs.readFileSync(path.join(root, name), encoding);
      },
    }),
  };
}

test('explicit URL bypasses a genuinely unreadable fallback', t => {
  const f = fixture(t, { file: `DATABASE_URL=${fallback}\n`, mode: 0o000, env: { DATABASE_URL: explicit } });
  assert.throws(() => fs.readFileSync(f.filename, 'utf8'), { code: 'EACCES' }, 'Run as an unprivileged user to exercise real permissions');
  assert.equal(f.evaluate(), explicit);
  assert.deepEqual(f.reads, []);
});

test('explicit URL works without a fallback file', t => {
  const f = fixture(t, { env: { DATABASE_URL: explicit } });
  assert.equal(f.evaluate(), explicit);
  assert.deepEqual(f.reads, []);
});

test('missing explicit URL uses the existing quoted .env format', t => {
  const f = fixture(t, { file: `UNRELATED=value\nDATABASE_URL="${fallback}"\n` });
  assert.equal(f.evaluate(), fallback);
  assert.deepEqual(f.reads, ['.env']);
});

test('empty explicit URL preserves fallback behavior', t => {
  const f = fixture(t, { file: `DATABASE_URL=${fallback}\n`, env: { DATABASE_URL: '' } });
  assert.equal(f.evaluate(), fallback);
});

test('no explicit URL and no usable fallback still fail', t => {
  for (const file of [undefined, '', 'UNRELATED=value\n', 'DATABASE_URL=not-a-url\n']) {
    const f = fixture(t, { file });
    assert.throws(f.evaluate, error => error.code === 'ERR_INVALID_URL');
  }
  const unreadable = fixture(t, { file: `DATABASE_URL=${fallback}\n`, mode: 0o000 });
  assert.throws(unreadable.evaluate, { code: 'EACCES' });
});

test('invalid explicit URL fails without silently selecting fallback', t => {
  const f = fixture(t, { file: `DATABASE_URL=${fallback}\n`, env: { DATABASE_URL: 'not-a-url' } });
  assert.throws(f.evaluate, error => error.code === 'ERR_INVALID_URL');
  assert.deepEqual(f.reads, []);
});

test('both configuration sources retain the loopback restriction', t => {
  const remote = 'postgresql://postgres:test@database.example:5432/test';
  for (const options of [{ env: { DATABASE_URL: remote } }, { file: `DATABASE_URL=${remote}\n` }]) {
    assert.throws(fixture(t, options).evaluate, /Only a loopback PostgreSQL server/);
  }
});
