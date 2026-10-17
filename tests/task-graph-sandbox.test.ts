import { executeCodexTask, resumeCodexSession } from '../src/lib/real-agents/codex-agent';
import { prepareGraphHarnessRuntime, clearGraphHarnessRuntime } from '../src/lib/task-graph/harness-runtime';
import { readFileSync } from 'node:fs';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ensureIntegrationRef, ensureJobWorktree, commitJobWorktree, integrateJobWorktree } from '../src/lib/task-graph/worktree';
import { linkedWorktreeGitDirectories } from '../src/lib/real-agents/git-worktree-paths';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeKimiCodeTask } from '../src/lib/real-agents/kimi-code-agent';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-sandbox-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const executable = path.join(root, 'kimi-probe');
  writeFileSync(executable, '#!/bin/sh\nif touch forbidden-code-write 2>/dev/null; then exit 19; fi\nprintf \'{"role":"assistant","content":"readonly enforced"}\\n\'\n', { mode: 0o700 });
  const previous = { CODEX_HOME: process.env.CODEX_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, TASK_GRAPH_RUNTIME_ROOT: process.env.TASK_GRAPH_RUNTIME_ROOT };
  const codexSource = path.join(root, 'codex-source'); mkdirSync(codexSource); writeFileSync(path.join(codexSource, 'auth.json'), '{"token":"fixture"}');
  const kimiSource = path.join(root, 'kimi-source'); mkdirSync(kimiSource); mkdirSync(path.join(kimiSource, 'oauth')); writeFileSync(path.join(kimiSource, 'oauth', 'token'), 'fixture'); writeFileSync(path.join(kimiSource, 'config.toml'), '# fixture');
  process.env.CODEX_HOME = codexSource; process.env.KIMI_CODE_HOME = kimiSource; process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  const original = process.env.KIMI_CODE_CLI_PATH; process.env.KIMI_CODE_CLI_PATH = executable;
  try {
    const result = await executeKimiCodeTask({ id: 'readonly-probe', name: 'readonly probe' }, {
      workingDirectory: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', permissionProfile: 'custom', networkAccess: 'restricted', timeout: 5000,
    });
    assert.equal(result.success, true, `Kimi must enforce readonly code at the actual native process boundary: ${result.error}`);
    const codexRuntime = prepareGraphHarnessRuntime('task-fixture', 'codex');
    writeFileSync(path.join(codexRuntime.config, 'auth.json'), '{"token":"refreshed"}');
    assert.equal(readFileSync(path.join(codexSource, 'auth.json'), 'utf8'), '{"token":"fixture"}', 'Private token refresh must not overwrite host configuration');
    const kimiRuntime = prepareGraphHarnessRuntime('task-fixture', 'kimi-code');
    writeFileSync(executable, `#!/bin/sh
test -r "$HOME/.kimi-code/config.toml" || exit 20
echo refreshed > "$HOME/.kimi-code/oauth/token" || exit 21
test "$TASK_GRAPH_UPSTREAM_INPUTS_JSON" = fixed-input-fixture || exit 23
if touch forbidden-code-write 2>/dev/null; then exit 22; fi
printf '%s\\n' '{"role":"assistant","content":"credential refresh writable; code readonly"}'
`, { mode: 0o700 });
    const taskEnvironment = { AP_PROJECT_REPOSITORY: workspace, TASK_GRAPH_UPSTREAM_INPUTS_JSON: 'fixed-input-fixture' };
    const refresh = await executeKimiCodeTask({ id: 'refresh-probe', name: 'refresh probe' }, { workingDirectory: workspace, workspaceRoot: workspace,
      sandboxMode: 'read-only', permissionProfile: 'custom', runtimeHome: kimiRuntime.home, taskEnvironment, extraReadOnlyPaths: kimiRuntime.readonly, extraWritableRoots: kimiRuntime.writable, timeout: 5000 });
    assert.equal(refresh.success, true, refresh.error);
    assert.equal(readFileSync(path.join(kimiSource, 'oauth/token'), 'utf8').trim(), 'refreshed');
    clearGraphHarnessRuntime('task-fixture');
    assert.equal(existsSync(codexRuntime.home), false);
    assert.equal(existsSync(path.join(kimiSource, 'oauth/token')), true, 'Cleaning private runtime must not traverse shared credential links');
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
test "$TASK_GRAPH_UPSTREAM_INPUTS_JSON" = fixed-input-fixture || exit 24
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"graph env propagated"}}'
printf '%s\\n' '{"type":"turn.completed"}'
`, { mode: 0o700 });
    const previousPath = process.env.PATH; process.env.PATH = bin + ':' + previousPath;
    try {
      const native = { workingDirectory: workspace, workspaceRoot: workspace, runtimeHome: codexRuntime.home, codexHome: codexRuntime.config,
        readOnlyPaths: codexRuntime.readonly, sandboxMode: 'read-only', approvalPolicy: 'never' as const, taskEnvironment, timeout: 5000 };
      const output = await executeCodexTask({ id: 'graph-native-env', name: 'graph native env' }, native);
      assert.equal(output.success, true, output.error); assert.match(output.output || '', /graph env propagated/);
      const continued = await resumeCodexSession({ ...native, threadId: 'fixture-thread', prompt: 'continue' });
      assert.match(continued.output, /graph env propagated/);
    } finally { process.env.PATH = previousPath; }
    const repository = path.join(root, 'repository'); mkdirSync(repository);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Test'); git(repository, 'config', 'user.email', 'test@example.test');
    writeFileSync(path.join(repository, 'baseline'), 'base'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    const integration = await ensureIntegrationRef({ repoPath: repository, runId: 'sandbox', baseRef: 'refs/heads/main', baseCommit: base });
    const job = await ensureJobWorktree({ repoPath: repository, runId: 'sandbox', jobId: 'one', baseRef: integration.ref, baseCommit: base });
    const metadata = linkedWorktreeGitDirectories(job.path);
    const native = wrapWithBubblewrap({ command: '/bin/sh', commandArgs: ['-c', 'printf feature > feature.txt && git rev-parse HEAD && ! git add feature.txt && ! git update-ref refs/heads/main HEAD && ! touch "$1/config"', 'sh', metadata[0]],
      cwd: job.path, workspaceRoot: job.path, env: process.env, readOnlyPaths: [...metadata, path.join(job.path, '.git')] });
    const edit = spawnSync(native.command, native.args, { encoding: 'utf8' });
    assert.equal(edit.status, 0, edit.stderr);
    const hookMarker = path.join(root, 'hook-escaped');
    const filterMarker = path.join(root, 'filter-escaped');
    const hooks = path.join(root, 'hooks'); mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\ntouch '+hookMarker+'\n', { mode: 0o700 });
    git(repository, 'config', 'core.hooksPath', hooks);
    git(repository, 'config', 'filter.escape.clean', 'touch '+filterMarker);
    git(repository, 'config', 'filter.escape.smudge', 'touch '+filterMarker);
    writeFileSync(path.join(job.path, '.gitattributes'), '*.txt filter=escape');
    const commit = await commitJobWorktree({ repoPath: repository, runId: 'sandbox', jobId: 'one', message: 'Controlled task delivery' });
    assert.equal(existsSync(hookMarker), false, 'Controlled commit must never execute task hooks on the host');
    assert.equal(existsSync(filterMarker), false, 'Controlled staging must never execute attribute filters on the host');
    assert.notEqual(commit, base);
    assert.equal(git(repository, 'rev-parse', 'refs/heads/main'), base);
    assert.equal(git(job.path, 'show', 'HEAD:feature.txt'), 'feature');
    await integrateJobWorktree({ repoPath: repository, runId: 'sandbox', jobId: 'one', integrationRef: integration.ref, expectedIntegrationCommit: base, baseCommit: base, verify: async (cwd) => {
      assert.equal(cwd, job.path);
    } });
    assert.equal(git(repository, 'rev-parse', integration.ref), commit);
    await ensureJobWorktree({ repoPath: repository, runId: 'sandbox', jobId: 'two', baseRef: integration.ref, baseCommit: commit });
    assert.equal(existsSync(filterMarker), false, 'New worktrees must not execute task-selected smudge filters');
    assert.equal(git(repository, 'rev-parse', 'refs/heads/main'), base);
    writeFileSync(path.join(job.path, '.gitignore'), 'scratch/\n');
    mkdirSync(path.join(job.path, 'scratch', 'inputs'), { recursive: true }); writeFileSync(path.join(job.path, 'scratch', 'inputs', 'answer.txt'), 'answer');
    git(job.path, 'add', '--force', 'scratch/inputs/answer.txt');
    await commitJobWorktree({ repoPath: repository, runId: 'sandbox', jobId: 'one', message: 'Declare check output' });
    const checked = await runSandboxedGraphCheck(['/bin/sh', '-c', 'test -z "$PLATFORM_PRIVATE_TOKEN" && test -z "$DATABASE_URL" && test -z "$OPENAI_API_KEY" && ! touch baseline && ! touch scratch/inputs/answer.txt && ! mv scratch/inputs scratch/relocated && echo report > scratch/report.txt && node --version && python --version'], job.path,
      { PLATFORM_PRIVATE_TOKEN: 'fixture-only', DATABASE_URL: 'fixture-only', OPENAI_API_KEY: 'fixture-only' });
    assert.match(checked.stdout, /Python/);
    assert.match(checked.stdout, /v[0-9]+/);
    const driverRepo = path.join(root, 'driver-repo'); mkdirSync(driverRepo);
    git(driverRepo, 'init', '-b', 'main'); git(driverRepo, 'config', 'user.name', 'Test'); git(driverRepo, 'config', 'user.email', 'test@example.test');
    const driverMarker = path.join(root, 'merge-driver-escaped');
    git(driverRepo, 'config', 'merge.escape.driver', 'touch ' + driverMarker);
    writeFileSync(path.join(driverRepo, '.gitattributes'), 'value merge=escape\n'); writeFileSync(path.join(driverRepo, 'value'), 'base\n');
    git(driverRepo, 'add', '.'); git(driverRepo, 'commit', '-m', 'base'); git(driverRepo, 'checkout', '-b', 'other');
    writeFileSync(path.join(driverRepo, 'value'), 'other\n'); git(driverRepo, 'commit', '-am', 'other'); git(driverRepo, 'checkout', 'main');
    writeFileSync(path.join(driverRepo, 'value'), 'main\n'); git(driverRepo, 'commit', '-am', 'main');
    const { graphGit } = await import('../src/lib/task-graph/git-command');
    await assert.rejects(() => graphGit(driverRepo, 'merge', '--no-edit', 'other'));
    assert.equal(existsSync(driverMarker), false, 'Platform merges must not execute custom attribute merge drivers');
    console.log('Native Kimi sandbox enforces the requested readonly phase');
  } finally {
    if (original === undefined) delete process.env.KIMI_CODE_CLI_PATH; else process.env.KIMI_CODE_CLI_PATH = original;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
