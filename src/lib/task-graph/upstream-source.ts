import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { graphGit } from './git-command';
const exec = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function upstreamRoot() {
  const root = process.env.TASK_GRAPH_UPSTREAM_ROOT || path.join(homedir(), '.agent-platform', 'task-upstream-sources');
  if (!path.isAbsolute(root)) throw new Error('Upstream root must be absolute');
  return root;
}

/** A verified plain tree, not a worktree and not another writable repository. Caller holds the repository lock. */
export async function materializeUpstream(repository: string, commit: string) {
  const maxBytes = Number(process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES ?? 256 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('TASK_GRAPH_UPSTREAM_MAX_BYTES must be a positive safe integer');
  const assertCapacity = (bytes: number) => {
    if (bytes > maxBytes) throw new Error(`上游源码 ${bytes} 字节超过宿主容量 ${maxBytes} 字节（TASK_GRAPH_UPSTREAM_MAX_BYTES）`);
  };
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid upstream commit');
  repository = await fs.realpath(repository);
  if (!await graphGit(repository, 'for-each-ref', '--contains', commit, '--format=%(refname)')) throw new Error('上游提交没有受保护 Git 引用，不能保证重建');
  const tree = await graphGit(repository, 'ls-tree', '-rlz', '--full-tree', commit);
  let total = 0;
  const files = tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +([0-9]+)\t(.+)$/.exec(entry);
    if (!match) throw new Error('上游源码包含符号链接、子模块或特殊文件，需显式适配');
    const name = match[4];
    total += Number(match[3]);
    assertCapacity(total);
    if (name.startsWith('/') || name.split('/').some(part => !part || part === '..' || part === '.' || part === '.git')) throw new Error('Unsafe upstream path');
    return { name, oid: match[2], mode: match[1] };
  });
  if (files.length > 30_000) throw new Error('上游源码超过 30000 文件限制');
  const directory = path.join(upstreamRoot(), digest(repository).slice(0, 24), commit);
  async function touch() {
    const metadata = directory + '.json';
    if (!(await fs.access(metadata).then(() => true, () => false))) await fs.writeFile(metadata, JSON.stringify({ repository, commit }), { flag: 'wx', mode: 0o600 });
    await fs.utimes(metadata, new Date(), new Date());
  }
  async function verify(target: string) {
    if (await fs.realpath(target) !== target || !(await fs.lstat(target)).isDirectory()) throw new Error('上游缓存路径不是受管普通目录');
    let bytes = 0;
    const found: string[] = [];
    async function walk(folder: string, prefix = ''): Promise<void> {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await walk(path.join(folder, entry.name), name + '/');
        else if (entry.isFile()) found.push(name);
        else throw new Error('上游缓存有非普通文件，保留现场');
      }
    }
    await walk(target);
    const names = new Set(files.map(file => file.name));
    if (found.length !== files.length || found.some(name => !names.has(name))) throw new Error('上游源码缓存文件清单不一致');
    for (const file of files) {
      const source = path.join(target, file.name);
      if (Boolean((await fs.stat(source)).mode & 0o111) !== (file.mode === '100755')) throw new Error('上游源码执行权限与 Git 不一致');
      const content = await fs.readFile(source);
      bytes += content.length;
      assertCapacity(bytes);
      if (content.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('上游包含未物化 LFS 内容，不能将指针当交付');
      const oid = createHash(file.oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${content.length}\0`).update(content).digest('hex');
      if (oid !== file.oid) throw new Error('上游固定源码内容与 Git 不一致，保留现场');
    }
  }
  async function preserveFileModes(target: string) {
    // Readonly binds enforce access; Git's normal modes must survive copies into writable test fixtures.
    for (const file of files) await fs.chmod(path.join(target, file.name), file.mode === '100755' ? 0o755 : 0o644);
  }
  if (await fs.access(directory).then(() => true, () => false)) { await verify(directory); await preserveFileModes(directory); await touch(); return directory; }
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = directory + '.preparing-' + randomUUID();
  const archive = temporary + '.tar';
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    await graphGit(repository, 'archive', '--format=tar', `--output=${archive}`, commit);
    await exec('tar', ['-xf', archive, '-C', temporary, '--no-same-owner', '--no-same-permissions'], { timeout: 60_000 });
    await verify(temporary);
    await preserveFileModes(temporary);
    await fs.rename(temporary, directory);
    await touch();
    return directory;
  } finally {
    await fs.rm(archive, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
