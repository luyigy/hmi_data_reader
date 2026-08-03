import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const git = async (repository: string, ...args: string[]) => (
  await execFileAsync('git', ['-C', repository, ...args], { encoding: 'utf8' })
).stdout.trim();

export async function resolveWorkflowCursorRecovery(
  repository: string,
  ref: string,
  cursor: unknown,
  expectedHead: string,
  strategy: string,
) {
  const current = cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    && typeof (cursor as Record<string, unknown>).commit === 'string'
    ? String((cursor as Record<string, unknown>).commit)
    : '';
  const latest = await git(repository, 'rev-parse', ref);
  if (!expectedHead || latest !== expectedHead) throw new Error(`Dashboard 已过期：当前 HEAD 为 ${latest}`);
  if (!current) throw new Error('watcher 当前没有可恢复的游标');
  if (await git(repository, 'merge-base', '--is-ancestor', current, latest).then(() => true, () => false)) {
    throw new Error('watcher 游标已属于当前历史，请刷新 Dashboard');
  }
  if (strategy === 'skip') return { current, latest, target: latest, skipped: true };
  if (strategy !== 'rescan') throw new Error('请选择“共同祖先重新扫描”或“当前 HEAD 跳过”');
  const target = await git(repository, 'merge-base', current, latest)
    .catch(() => { throw new Error('两段 Git 历史没有共同祖先，无法自动恢复'); });
  return { current, latest, target, skipped: false };
}
