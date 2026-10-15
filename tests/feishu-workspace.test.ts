import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWorkspaceRoot, resolveWorkspaceDirectory, resolveWorkspaceRoot } from '../src/lib/feishu-workspace';

void (async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ap-workspace-'));
  const root = path.join(base, 'user');
  const sibling = path.join(base, 'user-other');
  await mkdir(path.join(root, 'project'), { recursive: true });
  await mkdir(sibling);
  await symlink(sibling, path.join(root, 'escape'));

  assert.equal(await resolveWorkspaceRoot(root), root);
  assert.equal(await ensureWorkspaceRoot(root), root);
  const missing = path.join(base, 'new-user', 'project');
  assert.equal(await ensureWorkspaceRoot(missing), missing);
  assert.ok((await stat(missing)).isDirectory());
  await assert.rejects(ensureWorkspaceRoot('relative/workspace'), /绝对路径/);
  const file = path.join(base, 'file');
  await writeFile(file, '');
  await assert.rejects(ensureWorkspaceRoot(file), /不是目录/);
  assert.equal(await resolveWorkspaceDirectory(root, 'project'), path.join(root, 'project'));
  await assert.rejects(resolveWorkspaceDirectory(root, '../user-other'), /授权根目录内/);
  await assert.rejects(resolveWorkspaceDirectory(root, sibling), /授权根目录内/);
  await assert.rejects(resolveWorkspaceDirectory(root, 'escape'), /授权根目录内/);
})();
