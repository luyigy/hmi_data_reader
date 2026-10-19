import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareDeclaredRuntime } from '../src/lib/task-graph/runtime-preflight';
import { runtimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'runtime-continuity-'));
  try {
    const repo = path.join(scratch, 'repo'); await mkdir(path.join(repo, '.agent-platform'), { recursive: true });
    const modulePath = await realpath(path.dirname(require.resolve('playwright/package.json')));
    const corePath = await realpath(path.dirname(require.resolve('playwright-core/package.json')));
    const executable = await realpath('/opt/google/chrome/chrome');
    const approvedReadOnlyRoots = [modulePath, corePath, path.dirname(executable)];
    const declaration = { version: 1, browser: { module: { path: modulePath, sha256: await runtimeResourceDigest(modulePath) }, executable: { path: executable, sha256: await runtimeResourceDigest(executable) } } };
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(declaration));
    await writeFile(path.join(repo, 'source.txt'), 'readonly source');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test'); git('add', '.'); git('commit', '-m', 'Pinned runtime fixture');
    const sourceDeclaration = await runtimeDeclaration(repo); assert(sourceDeclaration);
    const out = path.join(scratch, 'implementation-output'); await mkdir(out);
    const implementation = await prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots, outputDirectory: out });
    assert(implementation.identity);
    const review = path.join(scratch, 'non-git-review'); await mkdir(review);
    const reviewOut = path.join(scratch, 'review-output'); await mkdir(reviewOut);
    const acceptance = await prepareDeclaredRuntime({ workspace: review, approvedReadOnlyRoots: [...approvedReadOnlyRoots, repo], outputDirectory: reviewOut,
      sourceDeclaration, resourceWorkspace: repo });
    assert.equal(acceptance.identity, implementation.identity, 'Non-Git acceptance must consume the same pinned source runtime, rather than silently dropping browser declaration');
    console.log(JSON.stringify({ identity: implementation.identity, acceptanceIdentity: acceptance.identity, browser: implementation.receipt, scenario: 'real browser implementation and non-Git acceptance' }));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
