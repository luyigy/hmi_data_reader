import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareGraphHarnessRuntime } from '../src/lib/task-graph/harness-runtime';
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
    const version = execFileSync('python3', ['-c', 'import sys;print(f"python{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8' }).trim();
    const runtime = prepareGraphHarnessRuntime('task-graph-python-fixture', 'codex');
    const packages = path.join(runtime.home, '.local', 'lib', version, 'site-packages'); mkdirSync(packages, { recursive: true });
    writeFileSync(path.join(packages, 'task_fixture_dependency.py'), 'value = "task-private dependency"\n');
    const checked = await runSandboxedGraphCheck(['python3', '-c', 'import os, task_fixture_dependency as d; print(d.value); assert not os.path.exists(' + JSON.stringify(path.join(runtime.home, '.codex/auth.json')) + ')'], repo, {}, [], 'task-graph-python-fixture');
    assert.match(checked.stdout, /task-private dependency/);
    await assert.rejects(runSandboxedGraphCheck(['python3', '-c', 'import task_fixture_dependency'], repo, {}, [], 'task-graph-another-fixture'), /ModuleNotFoundError/);
    await assert.rejects(runSandboxedGraphCheck(['python3', '-c', 'import task_fixture_dependency as d;open(d.__file__,"w")'], repo, {}, [], 'task-graph-python-fixture'), /Read-only file system/);
    await assert.rejects(runSandboxedGraphCheck(['python3', '-c', 'raise RuntimeError("readable failure")'], repo), error => {
      assert.match(String(error), /readable failure/); assert.doesNotMatch(String(error), /--unsetenv|--ro-bind|\/usr\/bin\/bwrap/); return true;
    });
    const folder = 'docs/specs/test'; mkdirSync(path.join(repo, folder), { recursive: true });
    writeFileSync(path.join(repo, folder, 'spec.md'), 'Approved frozen requirements');
    writeFileSync(path.join(repo, folder, 'route.json'), '{}');
    writeFileSync(path.join(repo, folder, 'spec-package.json'), JSON.stringify({ title: 'test', status: 'ready', spec: 'spec.md', route: 'route.json', artifacts: [] }));
    git('add', '.'); git('commit', '-m', 'Frozen Spec');
    const commit = git('rev-parse', 'HEAD');
    const spec = await loadSpecPackage(repo, commit, folder + '/spec-package.json'); assert.ok(spec);
    writeFileSync(path.join(repo, folder, 'spec.md'), 'Unapproved working copy');
    const input = await prepareGraphSpecInput({ specRef: 'fixture', specPackage: spec, nodes: [] });
    const file = path.join(input.paths[0], spec.specPath);
    const read = await runSandboxedGraphCheck(['cat', file], repo, {}, input.paths);
    assert.equal(read.stdout, 'Approved frozen requirements');
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo changed > "$1"', 'sh', file], repo, {}, input.paths), /Read-only file system/);
    assert.deepEqual(await prepareGraphSpecInput({ specRef: 'legacy', nodes: [] }), { paths: [], instructions: '' });
    console.log('Task-private Python dependencies and frozen cross-repository Spec inputs are readable without credentials; failures omit sandbox launch arguments');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
