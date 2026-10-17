import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { assertReviewWorkspacesClean, resolveReviewWorkspaces } from '../src/lib/task-graph/review-workspaces';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-graph-review-'));
  try {
    const executions = ['api', 'ui'].map((name) => {
      const repository = path.join(root, name), worktreePath = path.join(root, name + '-job');
      execFileSync('git', ['init', '-q', repository]);
      git(repository, 'config', 'user.email', 'test@example.com'); git(repository, 'config', 'user.name', 'Test');
      writeFileSync(path.join(repository, 'file.txt'), name);
      writeFileSync(path.join(repository, '.gitignore'), 'scratch/\n');
      git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'initial');
      git(repository, 'worktree', 'add', '-b', 'slice', worktreePath, 'HEAD');
      mkdirSync(path.join(worktreePath, 'scratch')); writeFileSync(path.join(worktreePath, 'scratch', 'roundtrip.json'), '{"saved":true}');
      return { repository, worktreePath, commit: git(repository, 'rev-parse', 'HEAD') };
    });
    const before = executions.map((e) => git(e.repository, 'worktree', 'list', '--porcelain'));
    const pinned = await resolveReviewWorkspaces(executions);
    assert.deepEqual(pinned.map((w) => w.path), executions.map((e) => e.worktreePath));
    assert.deepEqual(executions.map((e) => git(e.repository, 'worktree', 'list', '--porcelain')), before);
    assert.equal(readFileSync(path.join(pinned[0].path, 'scratch/roundtrip.json'), 'utf8'), '{"saved":true}');
    const wrapped = wrapWithBubblewrap({ command: '/usr/bin/sh',
      commandArgs: ['-c', `cat scratch/roundtrip.json && cat '${pinned[1].path}/file.txt' && ! touch file.txt && ! touch '${pinned[1].path}/file.txt'`],
      cwd: pinned[0].path, workspaceRoot: pinned[0].path, sandboxMode: 'read-only',
      readOnlyPaths: [pinned[1].path], env: process.env });
    const probe = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /saved/);
    assert.match(probe.stdout, /ui/);
    assert.match(probe.stderr, /Read-only file system/);
    writeFileSync(path.join(executions[0].repository, 'file.txt'), 'changed source');
    await assertReviewWorkspacesClean(pinned);
    writeFileSync(path.join(pinned[1].path, 'file.txt'), 'dirty job');
    await assert.rejects(resolveReviewWorkspaces(executions), /dirty/);
    writeFileSync(path.join(pinned[1].path, 'file.txt'), 'ui');
    git(pinned[1].path, 'commit', '--allow-empty', '-qm', 'unexpected advance');
    await assert.rejects(resolveReviewWorkspaces(executions), /changed/);
    const second = { ...executions[1], commit: git(pinned[1].path, 'rev-parse', 'HEAD') };
    const olderPath = path.join(root, 'ui-older-job');
    git(second.repository, 'worktree', 'add', '--detach', olderPath, executions[1].commit);
    const combined = await resolveReviewWorkspaces([second, { ...executions[1], worktreePath: olderPath }]);
    assert.equal(combined.length, 2, 'Keep both sibling workspaces available to the reviewer');
    assert.equal(combined.at(-1)?.commit, second.commit, 'Select the tested descendant for multiple jobs in one repository');
    console.log('Review reuses existing job workspaces and evidence, pins commits and rejects dirty code');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
