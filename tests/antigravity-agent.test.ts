import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeAntigravityTask } from '../src/lib/real-agents/antigravity-agent';

const run = async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'antigravity-test-'));
  const binary = path.join(fixtureDir, 'agy');
  const argsFile = path.join(fixtureDir, 'args');
  const cwdFile = path.join(fixtureDir, 'cwd');
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy test"
  exit 0
fi
printf '%s\\n' "$@" > "$AGY_ARGS_FILE"
pwd > "$AGY_CWD_FILE"
case "$AGY_TEST_CASE" in
  echo) printf 'Task: smoke\\n\\nPlease   complete this task.\\n' ;;
  empty) printf 'diagnostic from stderr' >&2 ;;
  text) printf 'Task completed with a valid answer.\\n' ;;
esac
`);
  await chmod(binary, 0o755);
  const projectsDir = path.join(fixtureDir, '.gemini/config/projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(path.join(projectsDir, 'bound.json'), JSON.stringify({
    id: 'bound-project',
    projectResources: { resources: [{ folderUri: `file://${process.cwd()}` }] },
  }));
  process.env.PATH = `${fixtureDir}:${originalPath || ''}`;
  process.env.HOME = fixtureDir;
  process.env.AGY_ARGS_FILE = argsFile;
  process.env.AGY_CWD_FILE = cwdFile;

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
    const answered = await executeAntigravityTask(
      { id: '3', name: 'smoke' },
      { workingDirectory: process.cwd() }
    );
    assert.equal(answered.success, true);
    assert.equal(answered.output, 'Task completed with a valid answer.');
    assert.match(await readFile(argsFile, 'utf8'), /^--project=bound-project$/m);
    assert.equal((await readFile(cwdFile, 'utf8')).trim(), process.cwd());

    await rm(path.join(projectsDir, 'bound.json'));
    await executeAntigravityTask(
      { id: '4', name: 'smoke' },
      { workingDirectory: process.cwd() }
    );
    const unboundArgs = await readFile(argsFile, 'utf8');
    assert.match(unboundArgs, /^--new-project$/m);

    const noFiles = await executeAntigravityTask({ id: '5', name: 'smoke' });
    assert.equal(noFiles.success, true);
    assert.deepEqual(noFiles.filesModified, []);
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    delete process.env.AGY_TEST_CASE;
    delete process.env.AGY_ARGS_FILE;
    delete process.env.AGY_CWD_FILE;
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

void run();
