import path from 'node:path';
import { homedir } from 'node:os';
import { realpath, access, constants, readdir } from 'node:fs/promises';
import { graphGit } from './git-command';
import { projectEnvironment } from '../harness/project-environment';
import { graphDependencyPaths } from './dependency-paths';
import { linkedWorktreeGitDirectories, workspaceGitDirectory } from '../real-agents/git-worktree-paths';

export type ExtraRepository = { repository: string; access: 'read' | 'write' };
export function validateExtraRepositories(repositories: ExtraRepository[] | undefined) {
  if (repositories === undefined) return;
  if (!Array.isArray(repositories) || repositories.length > 16) throw new Error('extraRepositories must be an array of at most 16 repositories');
  const paths = new Set<string>();
  for (const item of repositories) {
    if (!item || typeof item.repository !== 'string' || !path.isAbsolute(item.repository) || path.normalize(item.repository) !== item.repository ||
        !['read', 'write'].includes(item.access) || paths.has(item.repository)) throw new Error('Extra repo requires a unique absolute repository path and read/write access');
    paths.add(item.repository);
  }
}

/** Only approved Git roots are mounted. Environments and Git metadata remain readonly even for a writable repo. */
export async function prepareExtraRepositories(repositories: ExtraRepository[] = [], readOnly = false) {
  validateExtraRepositories(repositories);
  const paths: string[] = []; const writablePaths: string[] = [];
  const details = [];
  for (const item of repositories) {
    const root = await realpath(item.repository);
    const managedRoots = [process.env.TASK_GRAPH_UPSTREAM_ROOT || path.join(homedir(), '.agent-platform/task-upstream-sources'),
      process.env.TASK_GRAPH_VALIDATION_ROOT || path.join(homedir(), '.agent-platform/task-validation'),
      process.env.TASK_GRAPH_RUNTIME_ROOT || path.join(homedir(), '.agent-platform/task-runtime')];
    const managed = await Promise.all(managedRoots.map(directory => realpath(directory).catch(() => path.resolve(directory))));
    if (root.split(path.sep).some(part => ['.agent-platform-task-graph-worktrees', '.agent-platform-task-graph-results'].includes(part)) ||
        managed.some(directory => root === directory || root.startsWith(directory + path.sep))) throw new Error('Extra repo 不能指向平台临时工作区、缓存或归档目录');
    if (root !== item.repository || await graphGit(root, 'rev-parse', '--show-toplevel') !== root) throw new Error(`Extra repo 必须填写真实 Git 根目录：${item.repository}`);
    await access(root, constants.R_OK | (!readOnly && item.access === 'write' ? constants.W_OK : 0));
    const environment = projectEnvironment(root);
    const mode = readOnly ? 'read' : item.access;
    if (mode === 'write') writablePaths.push(root); else paths.push(root);
    paths.push(workspaceGitDirectory(root), ...linkedWorktreeGitDirectories(root), ...graphDependencyPaths(root), ...(environment ? [environment.directory] : []));
    details.push({ repository: root, access: mode, pythonExecutable: environment ? path.join(environment.directory, 'bin/python') : null,
      commit: await graphGit(root, 'rev-parse', 'HEAD') });
  }
  const allowed = [...repositories.map(item => item.repository), ...paths, ...writablePaths];
  for (const directory of [...repositories.map(item => item.repository), ...paths]) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isSymbolicLink()) continue;
      const target = await realpath(path.join(directory, entry.name)).catch(() => null);
      if (target && !allowed.some(root => target === root || target.startsWith(root + path.sep))) throw new Error(`Extra repo 外部链接需要显式授权：${directory}/${entry.name}`);
    }
  }
  const env: Record<string, string> = details.length ? { TASK_GRAPH_EXTRA_REPOS_JSON: JSON.stringify(details) } : {};
  return { paths: Array.from(new Set(paths)), writablePaths, details, env,
    instructions: details.length ? `\n已批准 extra repo：${JSON.stringify(details)}。这些是项目现有目录，非固定版本副本；使用这里的实际路径与已有环境，不再复制源码。只可按所列权限访问；Git 提交/合并由平台或明确批准的仓内执行处理，不自动提交额外仓改动。额外仓不属于临时目录，不能删除或清理。存在未提交的额外仓修改时须明确报告，不能将其当成已集成交付。` : '' };
}
