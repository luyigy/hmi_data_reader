import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integrateJobWithRetry } from '../src/lib/task-graph/integration-retry';
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

    await assert.rejects(() => integrateJobWithRetry({ ...request, jobId: 'B', integrationRef: integration.ref,
      expectedIntegrationCommit: first.commit, assertOwnership: async () => undefined, maxAttempts: 3,
      onRetry: async () => { assert.fail('Real conflicts must never become blind retries'); }, verify: async () => undefined }),
    (error: unknown) => error instanceof TaskGraphGitError && error.integration?.kind === 'conflict' && error.integration.mergeHead === first.commit);
    assert.equal(git(b.path, 'rev-parse', 'HEAD'), original);

    const setup = async (runId: string) => {
      const target = await ensureIntegrationRef({ repoPath: repo, runId, baseRef: 'refs/heads/main', baseCommit: base });
      const args = { repoPath: repo, runId, baseRef: target.ref, baseCommit: base, worktreeRoot: path.join(root, 'trees') };
      const candidate = await ensureJobWorktree({ ...args, jobId: 'candidate' });
      await fs.writeFile(path.join(candidate.path, 'candidate.txt'), runId);
      git(candidate.path, 'add', '.'); git(candidate.path, 'commit', '-m', runId);
      const sibling = await ensureJobWorktree({ ...args, jobId: 'sibling' });
      await fs.writeFile(path.join(sibling.path, 'sibling.txt'), runId);
      git(sibling.path, 'add', '.'); git(sibling.path, 'commit', '-m', 'sibling');
      return { args, target, candidate, siblingCommit: git(sibling.path, 'rev-parse', 'HEAD') };
    };
    const advance = await setup('advance');
    let checks = 0; const retries: string[] = [];
    const merged = await integrateJobWithRetry({ ...advance.args, jobId: 'candidate', integrationRef: advance.target.ref, expectedIntegrationCommit: base,
      assertOwnership: async () => undefined, maxAttempts: 3, onRetry: async failure => { retries.push(failure.code); },
      verify: async cwd => {
        checks++;
        assert.equal(await fs.readFile(path.join(cwd, 'candidate.txt'), 'utf8'), 'advance');
        if (checks === 1) git(repo, 'update-ref', advance.target.ref, advance.siblingCommit, base);
        else assert.equal(await fs.readFile(path.join(cwd, 'sibling.txt'), 'utf8'), 'advance');
      } });
    assert.equal(checks, 2, 'Integration ref advance must rerun checks on the newly merged tree');
    assert.deepEqual(retries, ['integration_stale']);
    assert.equal(git(repo, 'rev-parse', advance.target.ref), merged.commit);
    git(repo, 'merge-base', '--is-ancestor', advance.siblingCommit, merged.commit);

    const raced = await setup('cas-race');
    let fences = 0; let raceChecks = 0;
    const racedResult = await integrateJobWithRetry({ ...raced.args, jobId: 'candidate', integrationRef: raced.target.ref, expectedIntegrationCommit: base,
      maxAttempts: 3, onRetry: async () => undefined,
      assertOwnership: async () => { if (++fences === 2) git(repo, 'update-ref', raced.target.ref, raced.siblingCommit, base); },
      verify: async () => { raceChecks++; } });
    assert.equal(raceChecks, 2, 'A compare-and-swap race must trigger fresh merged-result verification');
    git(repo, 'merge-base', '--is-ancestor', raced.siblingCommit, racedResult.commit);

    const fenced = await setup('fence');
    let owned = true; const fencedHead = git(fenced.candidate.path, 'rev-parse', 'HEAD');
    await assert.rejects(integrateJobWithRetry({ ...fenced.args, jobId: 'candidate', integrationRef: fenced.target.ref, expectedIntegrationCommit: base,
      maxAttempts: 3, onRetry: async () => assert.fail('Lost ownership must never retry'),
      assertOwnership: async () => { if (!owned) throw new Error('execution ownership lost'); }, verify: async () => { owned = false; } }), /ownership lost/);
    assert.equal(git(repo, 'rev-parse', fenced.target.ref), base, 'Lost owner must not publish a ref');
    assert.equal(git(fenced.candidate.path, 'rev-parse', 'HEAD'), fencedHead);

    const beforeMerge = await setup('merge-fence');
    git(repo, 'update-ref', beforeMerge.target.ref, beforeMerge.siblingCommit, base);
    const beforeMergeHead = git(beforeMerge.candidate.path, 'rev-parse', 'HEAD'); let mergeFences = 0;
    await assert.rejects(integrateJobWithRetry({ ...beforeMerge.args, jobId: 'candidate', integrationRef: beforeMerge.target.ref, expectedIntegrationCommit: beforeMerge.siblingCommit,
      maxAttempts: 3, onRetry: async () => assert.fail('No retry after losing ownership before merge'),
      assertOwnership: async () => { if (++mergeFences === 2) throw new Error('owner lost before merge'); }, verify: async () => assert.fail('No checks before failed merge fence') }), /owner lost before merge/);
    assert.equal(git(beforeMerge.candidate.path, 'rev-parse', 'HEAD'), beforeMergeHead);
    assert.throws(() => git(beforeMerge.candidate.path, 'rev-parse', '--verify', 'MERGE_HEAD'));

    const checkFailure = await setup('check-failure'); const defect = new Error('typed check defect');
    await assert.rejects(integrateJobWithRetry({ ...checkFailure.args, jobId: 'candidate', integrationRef: checkFailure.target.ref, expectedIntegrationCommit: base,
      maxAttempts: 3, assertOwnership: async () => undefined, onRetry: async () => assert.fail('Verification failure belongs to repair, not integration stale retry'),
      verify: async () => { throw defect; } }),
    (error: unknown) => error instanceof TaskGraphGitError && error.code === 'verification_failed' && error.cause === defect);
    assert.equal(git(repo, 'rev-parse', checkFailure.target.ref), base);

    const wrongBranch = await setup('ownership');
    await assert.rejects(integrateJobWithRetry({ ...wrongBranch.args, jobId: 'candidate', integrationRef: wrongBranch.target.ref, expectedIntegrationCommit: base,
      maxAttempts: 3, assertOwnership: async () => undefined, onRetry: async () => assert.fail('Changed worktree identity must not retry'),
      verify: async cwd => { git(cwd, 'checkout', '-b', 'foreign-owner'); } }),
    (error: unknown) => error instanceof TaskGraphGitError && error.code === 'ownership_mismatch' && error.integration?.kind === 'ownership_mismatch');
    assert.equal(git(wrongBranch.candidate.path, 'branch', '--show-current'), 'foreign-owner');
    assert.equal(git(repo, 'rev-parse', wrongBranch.target.ref), base);

    const exhausted = await setup('exhausted');
    let failures = 0; let attempts = 0;
    await assert.rejects(integrateJobWithRetry({ ...exhausted.args, jobId: 'candidate', integrationRef: exhausted.target.ref, expectedIntegrationCommit: base,
      maxAttempts: 2, assertOwnership: async () => undefined, onRetry: async () => { failures++; },
      verify: async () => {
        attempts++;
        const current = git(repo, 'rev-parse', exhausted.target.ref);
        const next = git(repo, 'commit-tree', git(repo, 'rev-parse', `${current}^{tree}`), '-p', current, '-m', `external-${attempts}`);
        git(repo, 'update-ref', exhausted.target.ref, next, current);
      } }),
    (error: unknown) => error instanceof TaskGraphGitError && error.code === 'integration_retry_exhausted' && error.integration?.kind === 'retry_exhausted' && error.integration.attempts === 2);
    assert.equal(failures, 2); assert.equal(attempts, 2);
    assert.equal(await fs.readFile(path.join(exhausted.candidate.path, 'candidate.txt'), 'utf8'), 'exhausted');
    git(repo, 'merge-base', '--is-ancestor', base, git(repo, 'rev-parse', exhausted.target.ref));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Integration preserves conflict evidence; stale/CAS retries reverify both deliveries, fencing prevents lost-owner publication, branch changes and budget exhaustion remain explicit');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
