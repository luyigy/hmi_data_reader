import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { linkedWorktreeGitDirectories } from '../src/lib/real-agents/git-worktree-paths';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { prepareCodexHome, resolvePlatformLocalCodexHome } from '../src/lib/real-agents/codex-home';

const root = mkdtempSync(path.join(tmpdir(), 'codex-home-test-'));
try {
  const shared = path.join(root, 'shared');
  const room = path.join(root, 'rooms', 'room-1');
  mkdirSync(path.join(shared, 'skills'), { recursive: true });
  writeFileSync(path.join(shared, 'auth.json'), '{}');

  prepareCodexHome(room, shared);

  assert.equal(realpathSync(path.join(room, 'auth.json')), path.join(shared, 'auth.json'));
  assert.equal(realpathSync(path.join(room, 'skills')), path.join(shared, 'skills'));
  assert.equal(existsSync(path.join(room, 'sessions')), false);
  const repository = path.join(root, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Baseline');
  const worktree = path.join(root, 'worktree');
  git('worktree', 'add', '-b', 'job', worktree);
  const resolved = resolvePlatformLocalCodexHome(worktree)!;
  prepareCodexHome(resolved, shared);
  const gitDirectory = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  assert.equal(resolved, path.join(gitDirectory, 'agent-platform/codex/session'));
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  assert.equal(resolvePlatformLocalCodexHome(repository, '/runtime/room-1'), path.join(repository, '.git/agent-platform/codex/room-1'));
  const wrapped = wrapWithBubblewrap({ command: 'git', commandArgs: ['-C', worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Sandbox commit'],
    cwd: worktree, workspaceRoot: worktree, env: process.env, writableRoots: linkedWorktreeGitDirectories(worktree), configPaths: [resolved] });
  execFileSync(wrapped.command, wrapped.args, { cwd: worktree, stdio: 'pipe' });
  assert.equal(git('status', '--porcelain'), '');
  console.log('Codex runtime home works in ordinary repositories and linked worktrees');
} finally {
  rmSync(root, { recursive: true, force: true });
}
