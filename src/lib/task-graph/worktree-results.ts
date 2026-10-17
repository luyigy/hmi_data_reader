import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const caches = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache']);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Preserve outputs only when closing a task; roles continue to use its original checkout. */
export async function preserveWorktreeResults(workspace: string, directory: string, commit: string) {
  const relative = path.relative(workspace, directory);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Results must be outside the worktree');
  const { stdout } = await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: workspace, maxBuffer: 16 * 1024 * 1024 });
  const ignored = stdout.split('\0').filter(Boolean);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let total = 0;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ignored) {
    if (name.split('/').some((part) => caches.has(part))) continue;
    const source = path.join(workspace, name);
    if (!(await fs.lstat(source)).isFile()) throw new Error(`Keep worktree: unsupported output ${name}`);
    const bytes = await fs.readFile(source);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('Keep worktree: outputs exceed 256 MiB');
    const target = path.join(directory, 'files', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const digest = sha(bytes);
    try { await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (sha(await fs.readFile(target)) !== digest) throw new Error(`Keep worktree: output archive differs: ${name}`);
    files.push({ path: name, sha256: digest, bytes: bytes.length });
  }
  try {
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ commit, workspace, files, skippedCaches: ignored.length - files.length }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
    if (!existing.startsWith(JSON.stringify({ commit, workspace }).slice(0, -1) + ',"files":')) throw new Error('Keep worktree: result manifest belongs to another delivery');
  }
  for (const file of files) {
    if (sha(await fs.readFile(path.join(workspace, file.path))) !== file.sha256) throw new Error(`Keep worktree: output changed: ${file.path}`);
  }
  // Every non-cache output now has a verified durable copy. Never follow cache symlinks.
  for (const name of ignored) await fs.unlink(path.join(workspace, name));
  return { directory, files: files.length, bytes: total };
}
