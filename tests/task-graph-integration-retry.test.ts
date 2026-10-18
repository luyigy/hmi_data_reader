import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIntegrationRef, ensureJobWorktree, integrateJobWorktree, TaskGraphGitError } from '../src/lib/task-graph/worktree';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-integration-retry-'));
  try {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Integration Test');
    git(repo, 'config', 'user.email', 'integration@test.invalid');
    await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    const integration = await ensureIntegrationRef({ repoPath: repo, runId: 'conflict', baseRef: 'refs/heads/main', baseCommit: base });
    const request = { repoPath: repo, runId: 'conflict', baseRef: integration.ref, baseCommit: base, worktreeRoot: path.join(root, 'trees') };
    const a = await ensureJobWorktree({ ...request, jobId: 'A' });
    const b = await ensureJobWorktree({ ...request, jobId: 'B' });
    for (const [tree, value] of [[a.path, 'first\n'], [b.path, 'second\n']]) {
      await fs.writeFile(path.join(tree, 'shared.txt'), value);
      git(tree, 'add', '.'); git(tree, 'commit', '-m', value.trim());
    }
    const original = git(b.path, 'rev-parse', 'HEAD');
    const first = await integrateJobWorktree({ ...request, jobId: 'A', integrationRef: integration.ref, expectedIntegrationCommit: base, verify: async () => undefined });
    await assert.rejects(() => integrateJobWorktree({ ...request, jobId: 'B', integrationRef: integration.ref, expectedIntegrationCommit: first.commit, verify: async () => undefined }), (error: unknown) => {
      assert(error instanceof TaskGraphGitError);
      assert.equal(error.code, 'integration_conflict');
      assert('integration' in error && error.integration, 'Conflict must expose typed evidence, not just an error message');
      assert.deepEqual(error.integration, { kind: 'conflict', candidateCommit: original, integrationCommit: first.commit, mergeHead: first.commit, paths: ['shared.txt'] });
      return true;
    });
    assert.equal(git(b.path, 'rev-parse', 'MERGE_HEAD'), first.commit);
    assert.equal(git(b.path, 'rev-parse', 'HEAD'), original);
    assert.match(await fs.readFile(path.join(b.path, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
    assert.equal(git(repo, 'rev-parse', integration.ref), first.commit);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('integration failure evidence preserves both commits and conflict files');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
