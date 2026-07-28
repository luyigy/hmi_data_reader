import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeAntigravityTask } from '../src/lib/real-agents/antigravity-agent';

const run = async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'antigravity-test-'));
  const binary = path.join(fixtureDir, 'agy');
  const originalPath = process.env.PATH;
  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy test"
  exit 0
fi
case "$AGY_TEST_CASE" in
  echo) printf 'Task: smoke\\n\\nPlease   complete this task.\\n' ;;
  empty) printf 'diagnostic from stderr' >&2 ;;
  text) printf 'Task completed with a valid answer.\\n' ;;
esac
`);
  await chmod(binary, 0o755);
  process.env.PATH = `${fixtureDir}:${originalPath || ''}`;

  try {
    process.env.AGY_TEST_CASE = 'echo';
    const echoed = await executeAntigravityTask({ id: '1', name: 'smoke' });
    assert.equal(echoed.success, false);
    assert.match(echoed.error || '', /only the input prompt/);

    process.env.AGY_TEST_CASE = 'empty';
    const empty = await executeAntigravityTask({ id: '2', name: 'smoke' });
    assert.equal(empty.success, false);
    assert.equal(empty.error, 'Antigravity returned no final output: diagnostic from stderr');

    process.env.AGY_TEST_CASE = 'text';
    const answered = await executeAntigravityTask({ id: '3', name: 'smoke' });
    assert.equal(answered.success, true);
    assert.equal(answered.output, 'Task completed with a valid answer.');

    const noFiles = await executeAntigravityTask({ id: '4', name: 'smoke' });
    assert.equal(noFiles.success, true);
    assert.deepEqual(noFiles.filesModified, []);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.AGY_TEST_CASE;
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

void run();
