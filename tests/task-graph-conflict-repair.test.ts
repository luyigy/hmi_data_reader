import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIntegrationRef, ensureJobWorktree, integrateJobWorktree, TaskGraphGitError } from '../src/lib/task-graph/worktree';
import { integrateJobWithRetry } from '../src/lib/task-graph/integration-retry';
import { prepareConflictRepair, finishConflictRepair } from '../src/lib/task-graph/conflict-repair';
import type { IntegrationConflict } from '../src/lib/task-graph/integration-failure';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-conflict-repair-'));
  try {
    const repo = path.join(root, 'repo'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test');
    await fs.writeFile(path.join(repo, 'contract.md'), 'base\n'); await fs.writeFile(path.join(repo, 'outside'), 'preserve\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); const base = git(repo, 'rev-parse', 'HEAD');
    const setup = async (runId: string) => {
      const integration = await ensureIntegrationRef({ repoPath: repo, runId, baseRef: 'refs/heads/main', baseCommit: base });
      const args = { repoPath: repo, runId, baseRef: integration.ref, baseCommit: base, worktreeRoot: path.join(root, 'trees') };
      const a = await ensureJobWorktree({ ...args, jobId: 'A' }), b = await ensureJobWorktree({ ...args, jobId: 'B' });
      for (const [tree, content] of [[a.path, 'base\nfirst delivery\n'], [b.path, 'base\nsecond delivery\n']]) {
        await fs.writeFile(path.join(tree, 'contract.md'), content); git(tree, 'add', '.'); git(tree, 'commit', '-m', 'delivery');
      }
      const candidate = git(b.path, 'rev-parse', 'HEAD');
      const first = await integrateJobWorktree({ ...args, jobId: 'A', integrationRef: integration.ref, expectedIntegrationCommit: base, verify: async () => {} });
      let evidence: IntegrationConflict | undefined;
      await assert.rejects(integrateJobWorktree({ ...args, jobId: 'B', integrationRef: integration.ref, expectedIntegrationCommit: first.commit, verify: async () => {} }), error => {
        assert(error instanceof TaskGraphGitError && error.integration?.kind === 'conflict'); evidence = error.integration; return true;
      });
      assert(evidence);
      const request = { ...args, jobId: 'B', integrationRef: integration.ref, evidence, approvedCommits: [base, first.commit, candidate], assertOwnership: async () => {} };
      return { args, integration, first, candidate, b, request };
    };
    const normal = await setup('normal');
    const checkpoint = await prepareConflictRepair(normal.request);
    assert.deepEqual(checkpoint.paths, ['contract.md']);
    const output = path.join(root, 'resolution.json');
    await fs.writeFile(output, JSON.stringify({ files: [{ path: 'contract.md', content: 'base\nfirst delivery\nsecond delivery\n' }] }));
    const merged = await finishConflictRepair({ ...normal.request, checkpoint, resolutionFile: output });
    assert.deepEqual(git(normal.b.path, 'rev-list', '--parents', '-1', merged).split(' ').slice(1), [normal.candidate, normal.first.commit]);
    assert.equal(await finishConflictRepair({ ...normal.request, checkpoint, resolutionFile: output }), merged, 'Crash after Git commit must adopt exact saved merge without another commit');
    const next = await ensureJobWorktree({ ...normal.args, jobId: 'R04', baseCommit: normal.first.commit });
    await fs.writeFile(path.join(next.path, 'R04'), 'latest integration'); git(next.path, 'add', '.'); git(next.path, 'commit', '-m', 'R04');
    const advance = await integrateJobWorktree({ ...normal.args, jobId: 'R04', integrationRef: normal.integration.ref, expectedIntegrationCommit: normal.first.commit, verify: async () => {} });
    let checks = 0;
    const integrated = await integrateJobWithRetry({ ...normal.args, jobId: 'B', integrationRef: normal.integration.ref, expectedIntegrationCommit: advance.commit, maxAttempts: 3,
      assertOwnership: async () => {}, onRetry: async () => {}, verify: async cwd => {
        checks++; assert.equal(await fs.readFile(path.join(cwd, 'contract.md'), 'utf8'), 'base\nfirst delivery\nsecond delivery\n');
        assert.equal(await fs.readFile(path.join(cwd, 'R04'), 'utf8'), 'latest integration');
      } });
    assert.equal(checks, 1); git(repo, 'merge-base', '--is-ancestor', normal.candidate, integrated.commit); git(repo, 'merge-base', '--is-ancestor', advance.commit, integrated.commit);
    const unknown = await setup('unknown');
    await assert.rejects(prepareConflictRepair({ ...unknown.request, approvedCommits: [base, unknown.candidate] }), /provenance/);
    assert.equal(git(unknown.b.path, 'rev-parse', 'MERGE_HEAD'), unknown.first.commit);
    const scoped = await setup('scoped');
    await assert.rejects(prepareConflictRepair({ ...scoped.request, allowedPaths: ['elsewhere'] }), /scope/);
    const escaped = await setup('escaped'); const escapedCheckpoint = await prepareConflictRepair(escaped.request);
    await fs.writeFile(output, JSON.stringify({ files: [{ path: '../outside', content: 'bad' }] }));
    await assert.rejects(finishConflictRepair({ ...escaped.request, checkpoint: escapedCheckpoint, resolutionFile: output }), /paths/);
    assert.equal(git(escaped.b.path, 'rev-parse', 'HEAD'), escaped.candidate);
    await fs.writeFile(output, JSON.stringify({ files: [{ path: 'contract.md', content: 'resolved\n' }] }));
    await fs.writeFile(path.join(escaped.b.path, 'outside'), 'external change\n');
    await assert.rejects(finishConflictRepair({ ...escaped.request, checkpoint: escapedCheckpoint, resolutionFile: output }), /changed/);
    const fenced = await setup('fenced'); const fencedCheckpoint = await prepareConflictRepair(fenced.request);
    await assert.rejects(finishConflictRepair({ ...fenced.request, checkpoint: fencedCheckpoint, resolutionFile: output, assertOwnership: async () => { throw new Error('ownership lost'); } }), /ownership lost/);
    assert.equal(git(fenced.b.path, 'rev-parse', 'HEAD'), fenced.candidate);
    assert.equal(git(repo, 'rev-parse', fenced.integration.ref), fenced.first.commit);
    console.log('Bounded conflict repair preserves both deliveries, latest integration, commit-crash recovery, scope/provenance fences and external edits');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
