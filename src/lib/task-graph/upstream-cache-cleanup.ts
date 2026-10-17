import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { isRecord } from './implementation-result';
import { upstreamRoot } from './upstream-source';
import { withRepositoryLock } from './repository-lock';

/** Disposable fixed trees expire only when no active graph or Harness can be using them. Git refs and reports remain. */
export async function cleanupUpstreamSources(now = Date.now()) {
  const root = upstreamRoot();
  if (!await fs.access(root).then(() => true, () => false)) return;
  if (await prisma.taskRun.count({ where: { status: { in: ['pending', 'running'] } } })) return;
  for (const repo of await fs.readdir(root, { withFileTypes: true })) {
    if (!repo.isDirectory() || !/^[a-f0-9]{24}$/.test(repo.name)) continue;
    for (const file of await fs.readdir(path.join(root, repo.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-f0-9]{40,64}\.json$/.test(file.name)) continue;
      const metadata = path.join(root, repo.name, file.name);
      if (now - (await fs.stat(metadata)).mtimeMs < 7 * 86400_000) continue;
      const info: unknown = JSON.parse(await fs.readFile(metadata, 'utf8'));
      if (!isRecord(info) || typeof info.repository !== 'string' || typeof info.commit !== 'string' ||
          info.commit + '.json' !== file.name || createHash('sha256').update(info.repository).digest('hex').slice(0, 24) !== repo.name) continue;
      const directory = path.join(root, repo.name, info.commit);
      await withRepositoryLock(info.repository, async () => {
        const stamp = await fs.stat(metadata).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stamp || now - stamp.mtimeMs < 7 * 86400_000) return;
        if (await prisma.taskRun.count({ where: { status: { in: ['pending', 'running'] } } })) return;
        if (await prisma.taskGraphEvent.count({ where: { kind: 'task_inputs_prepared',
          run: { status: { notIn: ['completed', 'completed_unverified'] } }, payload: { path: ['inputs'], array_contains: [{ sourcePath: directory }] } } })) return;
        const actual = await fs.realpath(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (actual && actual !== directory) throw new Error('Refuse cleanup of redirected upstream cache');
        if (actual) await fs.rm(directory, { recursive: true });
        await fs.rm(metadata, { force: true });
      });
    }
  }
}
