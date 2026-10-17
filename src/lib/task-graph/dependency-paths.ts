import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';

/** Read host-installed dependencies from the source repository, never an agent-created link target. */
export function graphDependencyPaths(workspace: string | undefined) {
  if (!workspace) return [];
  const common = linkedWorktreeGitDirectories(workspace)[0];
  if (common && path.basename(common) !== '.git') return [];
  if (!common && !existsSync(path.join(workspace, '.git'))) return [];
  const repository = common ? path.dirname(common) : realpathSync(workspace);
  return ['node_modules', 'frontend/node_modules'].map((name) => path.join(repository, name))
    .filter(existsSync).map((entry) => realpathSync(entry));
}
