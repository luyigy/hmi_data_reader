import assert from 'node:assert/strict';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { projectEnvironment } from '../src/lib/harness/project-environment';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareGraphHarnessRuntime } from '../src/lib/task-graph/harness-runtime';
import { runtimeDeclaration } from '../src/lib/task-graph/runtime-contract';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { loadSpecPackage } from '../src/lib/task-graph/spec-package';
import { prepareGraphSpecInput } from '../src/lib/task-graph/spec-input';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-runtime-input-'));
  const previous = { TASK_GRAPH_RUNTIME_ROOT: process.env.TASK_GRAPH_RUNTIME_ROOT, TASK_GRAPH_SPEC_INPUT_ROOT: process.env.TASK_GRAPH_SPEC_INPUT_ROOT, CODEX_HOME: process.env.CODEX_HOME };
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_SPEC_INPUT_ROOT = path.join(root, 'specs');
  process.env.CODEX_HOME = path.join(root, 'auth');
  mkdirSync(process.env.CODEX_HOME); writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{"token":"fixture-only"}');
  try {
    const repo = path.join(root, 'repo'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    assert.equal(await runtimeDeclaration(repo), null, 'Unborn repository without a runtime declaration keeps the original execution flow');
    const branchFile = path.join(repo, '.git/refs/heads/main');
    writeFileSync(branchFile, 'ref: refs/heads/redirected\n');
    await assert.rejects(runtimeDeclaration(repo), error => error instanceof Error && 'code' in error && error.code === 128, 'Indirect unborn reference is not treated as an ordinary empty repository');
    rmSync(branchFile);
    writeFileSync(branchFile, 'invalid-object-id\n');
    await assert.rejects(runtimeDeclaration(repo), error => error instanceof Error && 'code' in error && error.code === 128, 'Corrupt branch reference remains an explicit error');
    rmSync(branchFile);
    const version = execFileSync('python3', ['-c', 'import sys;print(f"python{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8' }).trim();
    const runtime = prepareGraphHarnessRuntime('task-graph-python-fixture', 'codex');
    const venv = path.join(repo, '.venv');
    execFileSync('python3', ['-m', 'venv', '--without-pip', venv]);
    const packages = path.join(venv, 'lib', version, 'site-packages');
    writeFileSync(path.join(packages, 'task_fixture_dependency.py'), 'value = "project dependency"\n');
    const checked = await runSandboxedGraphCheck(['python3', '-c', 'import sys, os, task_fixture_dependency as d; print(d.value); assert sys.prefix == '+JSON.stringify(venv)+'; assert not os.path.exists(' + JSON.stringify(path.join(runtime.home, '.codex/auth.json')) + ')'], repo);
    assert.match(checked.stdout, /project dependency/);
    await assert.rejects(runSandboxedGraphCheck(['python3', '-c', 'import task_fixture_dependency as d;open(d.__file__,"w")'], repo), /Read-only file system/);
    await assert.rejects(runSandboxedGraphCheck(['python3', '-c', 'raise RuntimeError("readable failure")'], repo), error => {
      assert.match(String(error), /readable failure/); assert.doesNotMatch(String(error), /--unsetenv|--ro-bind|\/usr\/bin\/bwrap/); return true;
    });
    const folder = 'docs/specs/test'; mkdirSync(path.join(repo, folder), { recursive: true });
    writeFileSync(path.join(repo, folder, 'spec.md'), 'Approved frozen requirements');
    writeFileSync(path.join(repo, folder, 'route.json'), '{}');
    writeFileSync(path.join(repo, folder, 'spec-package.json'), JSON.stringify({ title: 'test', status: 'ready', spec: 'spec.md', route: 'route.json', artifacts: [] }));
    writeFileSync(path.join(repo, '.gitignore'), '.venv/\n'); git('add', '.'); git('commit', '-m', 'Frozen Spec');
    const commit = git('rev-parse', 'HEAD');
    const job = path.join(root, 'linked-job');
    git('worktree', 'add', '--detach', job, commit);
    const identity = 'import sys, task_fixture_dependency; print(sys.prefix); print(task_fixture_dependency.value)';
    const implementation = wrapWithBubblewrap({ command: 'bash', commandArgs: ['-lc', 'python3 -c '+"'"+identity+"'"], cwd: job, workspaceRoot: job, env: { ...process.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0' } });
    const implemented = execFileSync(implementation.command, implementation.args, { encoding: 'utf8' });
    assert.match(implemented, /project dependency/); assert.ok(implemented.includes(venv));
    const platform = await runSandboxedGraphCheck(['python3', '-c', identity], job);
    assert.equal(platform.stdout, implemented);
    assert.equal((await runSandboxedGraphCheck([path.join(venv, 'bin/python'), '-c', identity], job)).stdout, implemented);
    const review = path.join(root, 'review'); mkdirSync(review);
    const reviewer = wrapWithBubblewrap({ command: 'python3', commandArgs: ['-c', identity], cwd: review, workspaceRoot: review, readOnlyPaths: [job], env: { ...process.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0' } });
    assert.equal(execFileSync(reviewer.command, reviewer.args, { encoding: 'utf8' }), implemented);
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo forbidden > "$VIRTUAL_ENV/changed"'], job), /Read-only file system/);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(path.join(job, '.venv')), false, 'Checks must not create a task virtual environment');
    mkdirSync(path.join(repo, '.agent-platform'));
    const config = path.join(repo, '.agent-platform/project-environment.json');
    writeFileSync(config, JSON.stringify({ pythonEnvironment: '.venv' }));
    assert.equal(projectEnvironment(job)?.directory, venv);
    writeFileSync(config, JSON.stringify({ pythonEnvironment: 'missing-environment' }));
    assert.throws(() => projectEnvironment(job), /不会自动创建环境/);
    rmSync(config);

    const spec = await loadSpecPackage(repo, commit, folder + '/spec-package.json'); assert.ok(spec);
    writeFileSync(path.join(repo, folder, 'spec.md'), 'Unapproved working copy');
    const input = await prepareGraphSpecInput({ specRef: 'fixture', specPackage: spec, nodes: [] });
    const file = path.join(input.paths[0], spec.specPath);
    const read = await runSandboxedGraphCheck(['cat', file], repo, {}, input.paths);
    assert.equal(read.stdout, 'Approved frozen requirements');
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo changed > "$1"', 'sh', file], repo, {}, input.paths), /Read-only file system/);
    assert.deepEqual(await prepareGraphSpecInput({ specRef: 'legacy', nodes: [] }), { paths: [], instructions: '' });
    console.log('Project Python environment and frozen Spec inputs are shared readonly without credentials; failures omit sandbox launch arguments');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
