import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareGraphOutputRuntime } from '../src/lib/task-graph/output-runtime';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-output-contract-'));
  const old = process.env.TASK_GRAPH_VALIDATION_ROOT;
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'runtimes');
  try {
    const repository = path.join(root, 'repo'); mkdirSync(repository);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
    mkdirSync(path.join(repository, '.agent-platform'));
    writeFileSync(path.join(repository, '.agent-platform/outputs.json'), JSON.stringify({ version: 1, paths: ['output/job'], readOnlyPaths: ['output/job/input-materials'] }));
    writeFileSync(path.join(repository, '.gitignore'), 'output/\n'); writeFileSync(path.join(repository, 'source.txt'), 'protected');
    git('add', '.'); git('commit', '-qm', 'fixture');
    const workspace = path.join(root, 'job'); git('worktree', 'add', '--detach', workspace);
    mkdirSync(path.join(workspace, 'output/job/input-materials'), { recursive: true });
    writeFileSync(path.join(workspace, 'output/job/input-materials/original.jpeg'), 'original bytes');
    writeFileSync(path.join(workspace, 'output/job/report.json'), 'historical report');
    const command = ['python3', '-c', 'from pathlib import Path; import os; p=Path("output/job"); assert (p/"input-materials/original.jpeg").read_text()=="original bytes"; (p/"report.json").write_text("new report"); out=Path(os.environ["AP_GRAPH_OUTPUT_DIR"]); (out/"proof.txt").write_text("ok"); print(out)'];
    const result = await runSandboxedGraphCheck(command, workspace);
    assert.equal(readFileSync(path.join(result.stdout.trim(), 'proof.txt'), 'utf8'), 'ok');
    assert.equal(readFileSync(path.join(workspace, 'output/job/report.json'), 'utf8'), 'historical report');
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo bad > source.txt'], workspace), /Read-only file system/);
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo bad > output/job/input-materials/original.jpeg'], workspace), /Read-only file system/);
    assert.equal(readFileSync(path.join(workspace, 'output/job/input-materials/original.jpeg'), 'utf8'), 'original bytes');
    const first = await prepareGraphOutputRuntime('node-fixture', 'implementation', [workspace]);
    writeFileSync(path.join(first.directory, 'retained.txt'), 'retained');
    const copied = JSON.parse(first.env.AP_GRAPH_OUTPUT_PATHS_JSON)[path.join(workspace, 'output/job')];
    assert.equal(readFileSync(path.join(copied, 'report.json'), 'utf8'), 'historical report');
    assert.equal(existsSync(path.join(copied, 'input-materials/original.jpeg')), false, 'Readonly original images are mounted, not copied into each stage archive');
    const originalAlias = wrapWithBubblewrap({ command: 'sh', commandArgs: ['-c', 'cat "$1"; ! echo corrupt > "$1"', 'sh', path.join(copied, 'input-materials/original.jpeg')], cwd: workspace, workspaceRoot: workspace, env: { ...process.env, ...first.env } });
    assert.match(execFileSync(originalAlias.command, originalAlias.args, { env: { ...process.env, ...first.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /original bytes/);
    const same = await prepareGraphOutputRuntime('node-fixture', 'implementation', [workspace]);
    assert.equal(same.directory, first.directory);
    assert.equal(readFileSync(path.join(same.directory, 'retained.txt'), 'utf8'), 'retained');
    const next = await prepareGraphOutputRuntime('node-fixture', 'acceptance', [workspace]);
    assert.notEqual(first.directory, next.directory);
    const env = { ...process.env, ...first.env };
    const forged = { ...env, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: first.directory, target: path.join(workspace, 'source.txt'), readOnly: false }]) };
    assert.throws(() => wrapWithBubblewrap({ command: 'sh', commandArgs: [], cwd: workspace, workspaceRoot: workspace, env: forged }), /not explicitly declared/);
    mkdirSync(path.join(workspace, 'unapproved'));
    assert.throws(() => wrapWithBubblewrap({ command: 'sh', commandArgs: [], cwd: workspace, workspaceRoot: workspace, env: { ...env, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: first.directory, target: path.join(workspace, 'unapproved'), readOnly: false }]) } }), /not explicitly declared/);
    rmSync(path.join(workspace, 'unapproved'), { recursive: true });
    symlinkSync(repository, path.join(workspace, 'output/job/external'));
    await assert.rejects(prepareGraphOutputRuntime('node-fixture', 'symlink', [workspace]), /symlink/);
    unlinkSync(path.join(workspace, 'output/job/external'));
    await assert.rejects(prepareGraphOutputRuntime('node-fixture', 'original', [repository]), /original repository/);
    const jobGit = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    jobGit('add', '--force', 'output/job/input-materials/original.jpeg'); jobGit('commit', '-qm', 'tracked source fixture');
    await assert.rejects(prepareGraphOutputRuntime('node-fixture', 'tracked', [workspace]), /tracked input/);
    assert.equal(git('status', '--porcelain'), '');
    console.log('Declared legacy reports and AP_GRAPH_OUTPUT_DIR write into isolated runtime; source, original input and old reports remain unchanged');
  } finally {
    if (old === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = old;
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
