import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspacePath, workspaceSegment, projectWorkspaceDirectory } from '../workspace-layout';
import { graphGit } from './git-command';
import { withRepositoryLock } from './repository-lock';

/** Keep the original detached workspace when registered; new readers receive their own checkout. */
export async function ensureReadOnlyWorkspace(repository: string, commit: string, executionId: string) {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Read-only workspace requires a fixed commit');
  return withRepositoryLock(repository, async () => {
    const legacy = path.join(path.dirname(repository), '.agent-platform-conversation-worktrees', createHash('sha256').update(`${repository}:${commit}`).digest('hex'));
    const registry = await graphGit(repository, 'worktree', 'list', '--porcelain');
    const suffix = path.join(await projectWorkspaceDirectory(repository), 'readonly', workspaceSegment(executionId), workspaceSegment(commit));
    const existing = registry.split('\n\n').map(block => block.split('\n').find(line => line.startsWith('worktree '))?.slice(9)).filter((directory): directory is string => !!directory && directory.endsWith(path.sep + suffix));
    if (existing.length > 1) throw new Error('Multiple registered read-only workspaces; preserve for reconciliation');
    const legacyExists = await fs.lstat(legacy).then(() => true, () => false);
    const directory = existing[0] || (legacyExists ? legacy : await workspacePath(repository, 'readonly', [executionId, commit]));
    const registered = registry.split('\n\n').some(block => block.split('\n').includes(`worktree ${directory}`));
    if (!registered) {
      if (await fs.lstat(directory).then(() => true, () => false)) throw new Error('Unregistered read-only workspace must be preserved');
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await graphGit(repository, 'worktree', 'add', '--detach', directory, commit);
    }
    if (await graphGit(directory, 'rev-parse', 'HEAD') !== commit || await graphGit(directory, 'status', '--porcelain', '--untracked-files=all') ||
      await graphGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== await graphGit(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw new Error('Fixed conversation workspace identity changed');
    return directory;
  });
}
