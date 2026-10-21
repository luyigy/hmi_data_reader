import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupIntegratedJobWorktree,
  ensureIntegrationRef,
  ensureJobWorktree,
  integrateJobWorktree,
  TaskGraphGitError,
} from '../src/lib/task-graph/worktree';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-graph-git-'));
  const repo = path.join(root, 'repo');
  const trees = path.join(root, 'trees');
  await fs.mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  return { root, repo, trees, base: git(repo, 'rev-parse', 'HEAD') };
}

async function expectCode(action: () => Promise<unknown>, code: TaskGraphGitError['code']) {
  await assert.rejects(action, (error: unknown) => {
    if (!(error instanceof TaskGraphGitError) || error.code !== code) {
      console.error('unexpected task graph error', code, error);
      return false;
    }
    return true;
  });
}

async function run() {
  const first = await fixture();
  try {
    const integration = await ensureIntegrationRef({
      repoPath: first.repo, runId: 'run-1', baseRef: 'refs/heads/main', baseCommit: first.base,
    });
    assert.equal(integration.commit, first.base);
    assert.deepEqual(await ensureIntegrationRef({
      repoPath: first.repo, runId: 'run-1', baseRef: 'refs/heads/main', baseCommit: first.base,
    }), integration);

    const jobA = await ensureJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', baseRef: integration.ref,
      baseCommit: first.base, worktreeRoot: first.trees,
    });
    const sameA = await ensureJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', baseRef: integration.ref,
      baseCommit: first.base, worktreeRoot: first.trees,
    });
    assert.deepEqual(sameA, jobA);
    const jobB = await ensureJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'B', baseRef: integration.ref,
      baseCommit: first.base, worktreeRoot: first.trees,
    });
    assert.notEqual(jobA.path, jobB.path);
    assert.notEqual(jobA.branch, jobB.branch);
    await fs.writeFile(path.join(jobA.path, 'a.txt'), 'A\n');
    git(jobA.path, 'add', 'a.txt');
    git(jobA.path, 'commit', '-m', 'A');
    await fs.writeFile(path.join(jobB.path, 'b.txt'), 'B\n');
    git(jobB.path, 'add', 'b.txt');
    git(jobB.path, 'commit', '-m', 'B');
    let verifiedA = false;
    const mergedA = await integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      expectedIntegrationCommit: first.base, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async (staging) => {
        assert.equal(staging, jobA.path, 'Implementation and checks must use the same worktree');
        assert.equal(await fs.readFile(path.join(staging, 'a.txt'), 'utf8'), 'A\n');
        await fs.mkdir(path.join(staging, 'cache'));
        await fs.writeFile(path.join(staging, 'cache', 'test.log'), 'ignored build output');
        verifiedA = true;
      },
    });
    assert(verifiedA);
    assert.equal(await fs.readFile(path.join(jobA.path, 'cache/test.log'), 'utf8'), 'ignored build output', 'Keep evidence for read-only review');
    assert.equal(git(first.repo, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 3, 'Integration must not create another checkout');
    assert.equal(git(first.repo, 'rev-parse', integration.ref), mergedA.commit);
    assert.equal(git(first.repo, 'rev-parse', 'refs/heads/main'), first.base);
    let reverified = false;
    assert.equal((await integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      expectedIntegrationCommit: first.base, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async (staging) => {
        assert.equal(await fs.readFile(path.join(staging, 'a.txt'), 'utf8'), 'A\n');
        reverified = true;
      },
    })).alreadyIntegrated, true);
    assert(reverified);
    let failedStage = '';
    await assert.rejects(() => integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      expectedIntegrationCommit: first.base, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async () => { throw new Error('check failed after crash recovery'); },
    }), (error: unknown) => {
      if (!(error instanceof TaskGraphGitError) || error.code !== 'verification_failed') return false;
      assert.match(error.message, /check failed after crash recovery/, 'Surface the check failure instead of only the staging path');
      failedStage = error.workspacePath || '';
      return true;
    });
    assert.equal(await fs.access(failedStage).then(() => true, () => false), true);
    assert.equal(git(first.repo, 'rev-parse', integration.ref), mergedA.commit);
    assert.equal((await integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      expectedIntegrationCommit: first.base, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async () => undefined,
    })).alreadyIntegrated, true);
    assert.equal(await fs.access(failedStage).then(() => true, () => false), true);
    await expectCode(() => integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: first.base, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async () => undefined,
    }), 'integration_stale');
    const mergedB = await integrateJobWorktree({
      repoPath: first.repo, runId: 'run-1', jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: mergedA.commit, baseCommit: first.base, worktreeRoot: first.trees,
      verify: async (staging) => {
        assert.equal(await fs.readFile(path.join(staging, 'a.txt'), 'utf8'), 'A\n');
        assert.equal(await fs.readFile(path.join(staging, 'b.txt'), 'utf8'), 'B\n');
      },
    });
    assert.notEqual(mergedB.commit, mergedA.commit);
    assert.equal(git(first.repo, 'merge-base', '--is-ancestor', mergedA.commit, mergedB.commit), '');
    await expectCode(() => cleanupIntegratedJobWorktree({ assertReleased: async () => {}, repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref, worktreeRoot: first.trees }), 'workspace_dirty');
    await fs.rm(path.join(jobA.path, 'cache'), { recursive: true });
    await cleanupIntegratedJobWorktree({ assertReleased: async () => {},
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      worktreeRoot: first.trees,
    });
    await cleanupIntegratedJobWorktree({ assertReleased: async () => {},
      repoPath: first.repo, runId: 'run-1', jobId: 'A', integrationRef: integration.ref,
      worktreeRoot: first.trees,
    });
    assert.equal(await fs.access(jobA.path).then(() => true, () => false), false);
    await fs.writeFile(path.join(jobB.path, 'untracked.txt'), 'keep');
    await expectCode(() => cleanupIntegratedJobWorktree({ assertReleased: async () => {},
      repoPath: first.repo, runId: 'run-1', jobId: 'B', integrationRef: integration.ref,
      worktreeRoot: first.trees,
    }), 'workspace_dirty');
    assert.equal(await fs.readFile(path.join(jobB.path, 'untracked.txt'), 'utf8'), 'keep');
    await fs.unlink(path.join(jobB.path, 'untracked.txt'));
    await cleanupIntegratedJobWorktree({ assertReleased: async () => {},
      repoPath: first.repo, runId: 'run-1', jobId: 'B', integrationRef: integration.ref,
      worktreeRoot: first.trees,
    });
  } finally {
    await fs.rm(first.root, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const integration = await ensureIntegrationRef({
      repoPath: second.repo, runId: 'conflict', baseRef: 'refs/heads/main', baseCommit: second.base,
    });
    const a = await ensureJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'A', baseRef: integration.ref,
      baseCommit: second.base, worktreeRoot: second.trees,
    });
    const b = await ensureJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'B', baseRef: integration.ref,
      baseCommit: second.base, worktreeRoot: second.trees,
    });
    for (const [worktree, content] of [[a.path, 'A\n'], [b.path, 'B\n']]) {
      await fs.writeFile(path.join(worktree, 'shared.txt'), content);
      git(worktree, 'add', 'shared.txt');
      git(worktree, 'commit', '-m', content.trim());
    }
    const mergedA = await integrateJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'A', integrationRef: integration.ref,
      expectedIntegrationCommit: second.base, baseCommit: second.base, worktreeRoot: second.trees,
      verify: async () => undefined,
    });
    let conflictPath = '';
    await assert.rejects(() => integrateJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: mergedA.commit, baseCommit: second.base, worktreeRoot: second.trees,
      verify: async () => undefined,
    }), (error: unknown) => {
      if (!(error instanceof TaskGraphGitError) || error.code !== 'integration_conflict') return false;
      conflictPath = error.workspacePath || '';
      return true;
    });
    assert(conflictPath);
    assert.match(await fs.readFile(path.join(conflictPath, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
    assert.equal(git(second.repo, 'rev-parse', integration.ref), mergedA.commit);
    await expectCode(() => integrateJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: mergedA.commit, baseCommit: second.base, worktreeRoot: second.trees,
      verify: async () => undefined,
    }), 'integration_conflict');
    await fs.writeFile(path.join(conflictPath, 'shared.txt'), 'A and B\n');
    git(conflictPath, 'add', 'shared.txt');
    git(conflictPath, 'commit', '-m', 'resolve conflict');
    const mergedB = await integrateJobWorktree({
      repoPath: second.repo, runId: 'conflict', jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: mergedA.commit, baseCommit: second.base, worktreeRoot: second.trees,
      verify: async (staging) => assert.equal(await fs.readFile(path.join(staging, 'shared.txt'), 'utf8'), 'A and B\n'),
    });
    assert.equal(git(second.repo, 'rev-parse', integration.ref), mergedB.commit);
  } finally {
    await fs.rm(second.root, { recursive: true, force: true });
  }

  const third = await fixture();
  try {
    const integration = await ensureIntegrationRef({
      repoPath: third.repo, runId: 'verify', baseRef: 'refs/heads/main', baseCommit: third.base,
    });
    const job = await ensureJobWorktree({
      repoPath: third.repo, runId: 'verify', jobId: 'one', baseRef: integration.ref,
      baseCommit: third.base, worktreeRoot: third.trees,
    });
    await fs.writeFile(path.join(job.path, 'feature.txt'), 'new');
    git(job.path, 'add', 'feature.txt');
    git(job.path, 'commit', '-m', 'feature');
    let stagingPath = '';
    await assert.rejects(() => integrateJobWorktree({
      repoPath: third.repo, runId: 'verify', jobId: 'one', integrationRef: integration.ref,
      expectedIntegrationCommit: third.base, baseCommit: third.base, worktreeRoot: third.trees,
      verify: async () => { throw new Error('tests failed'); },
    }), (error: unknown) => {
      if (!(error instanceof TaskGraphGitError) || error.code !== 'verification_failed') return false;
      stagingPath = error.workspacePath || '';
      return true;
    });
    assert.equal(git(third.repo, 'rev-parse', integration.ref), third.base);
    assert.equal(await fs.access(stagingPath).then(() => true, () => false), true);
    await fs.writeFile(path.join(job.path, 'verification-entry.sh'), 'echo verified\n');
    git(job.path, 'add', 'verification-entry.sh');
    git(job.path, 'commit', '-m', 'add missing verification entry');
    const fixedHead = git(job.path, 'rev-parse', 'HEAD');
    const merged = await integrateJobWorktree({
      repoPath: third.repo, runId: 'verify', jobId: 'one', integrationRef: integration.ref,
      expectedIntegrationCommit: third.base, baseCommit: third.base, worktreeRoot: third.trees,
      verify: async (staging) => assert.equal(await fs.readFile(path.join(staging, 'verification-entry.sh'), 'utf8'), 'echo verified\n'),
    });
    assert.equal(git(third.repo, 'merge-base', '--is-ancestor', fixedHead, merged.commit), '');
    assert.equal(git(third.repo, 'rev-parse', integration.ref), merged.commit);
    git(third.repo, 'worktree', 'add', '--detach', path.join(third.root, 'checked-out'), integration.ref);
    git(path.join(third.root, 'checked-out'), 'switch', integration.ref.slice('refs/heads/'.length));
    await expectCode(() => integrateJobWorktree({
      repoPath: third.repo, runId: 'verify', jobId: 'one', integrationRef: integration.ref,
      expectedIntegrationCommit: merged.commit, baseCommit: third.base, worktreeRoot: third.trees,
      verify: async () => undefined,
    }), 'integration_checked_out');
  } finally {
    await fs.rm(third.root, { recursive: true, force: true });
  }
  console.log('task graph worktree lifecycle checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
