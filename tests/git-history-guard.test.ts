import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureAppendOnlyGitRef } from '../src/lib/scheduled-jobs/git-history-guard';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-history-guard-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'policy'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'policy/contract.yaml'),
    await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml')),
  );
  await writeFile(path.join(root, 'docs/000_ROADMAP_20260730_test.md'), '# roadmap\n');
  await writeFile(path.join(root, 'docs/001_PLAN_20260730_valid.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: 000_ROADMAP_20260730_test.md
parent_plan: null
parent_slice: null
return_to: null
---
S01
<!-- WORKFLOW_PROMPT_START -->
执行 001_PLAN_20260730_valid.md 的 S01，遵循 000_ROADMAP_20260730_test.md。
<!-- WORKFLOW_PROMPT_END -->
`);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const first = git('rev-parse', 'HEAD');

  const hookPath = path.resolve(root, git('rev-parse', '--git-path', 'hooks/reference-transaction'));
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, '#!/bin/sh\n# agent-platform append-only ref guard v1\nexit 0\n');
  await ensureAppendOnlyGitRef(
    root,
    'refs/heads/main',
    new AbortController().signal,
    'policy/contract.yaml',
  );
  const hookSource = await readFile(hookPath, 'utf8');
  assert.match(hookSource, /append-only ref guard v4/);
  assert.doesNotMatch(hookSource, /agent-platform-v2|ts-node|node_modules|validate-workflow-documents\.ts/);
  const validatorPath = path.resolve(root, git('rev-parse', '--git-path', 'agent-platform/workflow-validator.cjs'));
  assert.ok((await stat(validatorPath)).size > 0);
  const validatorSource = await readFile(validatorPath, 'utf8');
  assert.ok(!validatorSource.includes(process.cwd()));
  assert.doesNotMatch(validatorSource, /require\(['"]yaml/);

  await writeFile(hookPath, '#!/bin/sh\n# agent-platform append-only ref guard v2\nexit 0\n');
  await ensureAppendOnlyGitRef(root, 'refs/heads/main', new AbortController().signal, 'policy/contract.yaml');
  assert.match(await readFile(hookPath, 'utf8'), /append-only ref guard v4/);

  await writeFile(hookPath, '#!/bin/sh\n# agent-platform append-only ref guard v3\nexit 0\n');
  await ensureAppendOnlyGitRef(root, 'refs/heads/main', new AbortController().signal, 'policy/contract.yaml');
  assert.equal(await readFile(hookPath, 'utf8'), hookSource);

  await writeFile(path.join(root, 'README.md'), 'ok\n');
  git('add', '.');
  git('commit', '--no-verify', '-qm', 'non-workflow change');
  await writeFile(
    path.join(root, 'docs/001_PLAN_20260730_valid.md'),
    `${await readFile(path.join(root, 'docs/001_PLAN_20260730_valid.md'), 'utf8')}\n`,
  );
  git('add', '.');
  const valid = spawnSync('git', ['-C', root, 'commit', '--no-verify', '-qm', 'valid workflow change'], {
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(valid.stderr, /validator (runtime failure|could not run)/);
  const third = git('rev-parse', 'HEAD');

  const zero = '0'.repeat(first.length);
  const forced = spawnSync(hookPath, ['prepared'], {
    cwd: root,
    encoding: 'utf8',
    input: `${zero} ${first} refs/heads/main\n`,
  });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /blocked non-fast-forward update/);
  const deleted = spawnSync(hookPath, ['prepared'], {
    cwd: root,
    encoding: 'utf8',
    input: `${third} ${zero} refs/heads/main\n`,
  });
  assert.equal(deleted.status, 1);
  assert.match(deleted.stderr, /blocked deletion/);

  // Exercise real Git transactions: packing removes loose storage, not the ref.
  const rejectRefChange = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `unexpectedly allowed: ${args.join(' ')}`);
    assert.match(result.stderr, /Agent Platform blocked/);
    assert.equal(git('rev-parse', 'refs/heads/main'), third);
  };
  rejectRefChange('update-ref', '-d', 'refs/heads/main', third);
  git('pack-refs', '--all', '--no-prune');
  // Both packed and loose copies exist: matching packed OID alone is unsafe.
  rejectRefChange('update-ref', '-d', 'refs/heads/main', third);
  git('pack-refs', '--all');
  assert.equal(git('rev-parse', 'refs/heads/main'), third);
  await assert.rejects(stat(path.resolve(root, git('rev-parse', '--git-path', 'refs/heads/main'))),
    { code: 'ENOENT' });
  rejectRefChange('update-ref', '-d', 'refs/heads/main');
  rejectRefChange('update-ref', '-d', 'refs/heads/main', third);
  rejectRefChange('update-ref', 'refs/heads/main', first);
  git('-c', 'gc.packRefs=true', 'gc');
  assert.equal(git('rev-parse', 'refs/heads/main'), third);

  await rename(validatorPath, `${validatorPath}.missing`);
  await writeFile(
    path.join(root, 'docs/001_PLAN_20260730_valid.md'),
    `${await readFile(path.join(root, 'docs/001_PLAN_20260730_valid.md'), 'utf8')}\nruntime fallback\n`,
  );
  git('add', '.');
  const runtimeFailure = spawnSync('git', ['-C', root, 'commit', '--no-verify', '-qm', 'validator runtime failure'], {
    encoding: 'utf8',
  });
  assert.equal(runtimeFailure.status, 0, runtimeFailure.stderr);
  assert.match(runtimeFailure.stderr, /validator could not run.*commit allowed/);
  await ensureAppendOnlyGitRef(root, 'refs/heads/main', new AbortController().signal, 'policy/contract.yaml');
  const runtimeAllowedHead = git('rev-parse', 'HEAD');

  await writeFile(
    path.join(root, 'docs/001_PLAN_20260730_valid.md'),
    (await readFile(path.join(root, 'docs/001_PLAN_20260730_valid.md'), 'utf8')).replace('doc_status: ready', 'doc_status: weakened'),
  );
  await writeFile(
    path.join(root, 'policy/contract.yaml'),
    (await readFile(path.join(root, 'policy/contract.yaml'), 'utf8')).replace(
      '    - ready',
      '    - ready\n    - weakened',
    ),
  );
  git('add', '.');
  assert.throws(
    () => git('commit', '--no-verify', '-qm', 'self-weakening contract'),
    /无效的文档状态/,
  );
  assert.equal(git('rev-parse', 'HEAD'), runtimeAllowedHead);

  // A missing contract registration is a platform-side gap: it must degrade
  // to a warning and allow the commit instead of freezing all commits.
  await rm(path.resolve(root, git('rev-parse', '--git-path', 'agent-platform/workflow-contracts')), { force: true });
  await writeFile(
    path.join(root, 'docs/001_PLAN_20260730_valid.md'),
    `${await readFile(path.join(root, 'docs/001_PLAN_20260730_valid.md'), 'utf8')}\nunregistered contract\n`,
  );
  git('add', '.');
  const unregistered = spawnSync('git', ['-C', root, 'commit', '--no-verify', '-qm', 'unregistered contract'], {
    encoding: 'utf8',
  });
  assert.equal(unregistered.status, 0, unregistered.stderr);
  assert.match(unregistered.stderr, /contract is not registered.*WITHOUT validation/);
  console.log('reference-transaction history and workflow validation checks passed');
}

void main();
