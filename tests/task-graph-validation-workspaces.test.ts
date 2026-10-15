import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertValidationWorkspacesClean, ensureValidationWorkspaces } from '../src/lib/task-graph/validation-workspaces';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-graph-validation-'));
  try {
    const repositories = ['api', 'ui'].map((name) => {
      const directory = path.join(root, name);
      execFileSync('git', ['init', '-q', directory]);
      git(directory, 'config', 'user.email', 'test@example.com');
      git(directory, 'config', 'user.name', 'Test');
      writeFileSync(path.join(directory, 'file.txt'), name);
      git(directory, 'add', 'file.txt');
      git(directory, 'commit', '-qm', 'initial');
      return { repository: directory, commit: git(directory, 'rev-parse', 'HEAD') };
    });
    const args = { runId: 'run-1', nodeKey: 'V1', commits: repositories };
    const pinned = await ensureValidationWorkspaces(args);
    assert.equal(pinned.length, 2);
    assert.deepEqual((await ensureValidationWorkspaces(args)).map((item) => item.path), pinned.map((item) => item.path));
    writeFileSync(path.join(repositories[0].repository, 'file.txt'), 'changed source');
    await assertValidationWorkspacesClean(pinned);
    writeFileSync(path.join(pinned[1].path, 'file.txt'), 'dirty pinned');
    await assert.rejects(ensureValidationWorkspaces(args), /dirty/);
    console.log('Task graph pinned multi-repository validation checks passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
