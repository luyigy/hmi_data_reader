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
  const workspace = path.join(fixtureDir, 'workspace');
  const outsideFile = path.join(fixtureDir, 'outside-secret');
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
  sandbox)
    test ! -e "$AGY_OUTSIDE_FILE" || exit 9
    printf sandboxed > sandbox-write
    printf 'Task completed inside the sandbox.\\n'
    ;;
esac
`);
  await chmod(binary, 0o755);
  await mkdir(workspace);
  await writeFile(outsideFile, 'secret');
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
    assert.equal((await readFile(cwdFile, 'utf8')).trim(), process.cwd());

    const noFiles = await executeAntigravityTask({ id: '5', name: 'smoke' });
    assert.equal(noFiles.success, true);
    assert.deepEqual(noFiles.filesModified, []);

    process.env.AGY_TEST_CASE = 'sandbox';
    process.env.AGY_ARGS_FILE = path.join(workspace, 'args');
    process.env.AGY_CWD_FILE = path.join(workspace, 'cwd');
    process.env.AGY_OUTSIDE_FILE = outsideFile;
    const sandboxed = await executeAntigravityTask(
      { id: '6', name: 'smoke' },
      { workingDirectory: workspace, workspaceRoot: workspace, networkAccess: 'restricted' },
    );
    assert.equal(sandboxed.success, true, sandboxed.error);
    assert.equal(sandboxed.output, 'Task completed inside the sandbox.');
    assert.equal(await readFile(path.join(workspace, 'sandbox-write'), 'utf8'), 'sandboxed');

    const { executeViaLocalHarness } = await import('../src/lib/acpx/runner-harness');
    const { clearRunningProcess } = await import('../src/lib/acpx/process-registry');
    const participant = {
      gatewayId: 'platform-local',
      executionBackend: 'platform_local' as const,
      harnessType: 'antigravity',
      role: 'custom',
    };
    const integrated = await executeViaLocalHarness(
      {
        taskId: 'restricted-antigravity',
        taskName: 'restricted-antigravity',
        orchestrationMode: 'single',
        participants: [participant],
        workingDirectory: workspace,
        permissionConfig: {
          profile: 'safe_local',
          sandboxMode: 'workspace-write',
          networkAccess: 'restricted',
          approvalPolicy: 'never',
          writableRoots: [workspace],
        },
      },
      'run',
      'participant',
      participant,
      {},
      [],
      { transcript: '', latestUserMessage: null },
    );
    assert.equal(integrated.output, 'Task completed inside the sandbox.');
    clearRunningProcess('participant');
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    delete process.env.AGY_TEST_CASE;
    delete process.env.AGY_ARGS_FILE;
    delete process.env.AGY_CWD_FILE;
    delete process.env.AGY_OUTSIDE_FILE;
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

void run();
