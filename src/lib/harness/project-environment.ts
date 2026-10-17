import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';

export type ProjectEnvironment = { repository: string; directory: string; env: Record<string, string> };

/** Resolve from the source repository, so a linked checkout cannot select its own environment. */
export function projectEnvironment(workspace: string): ProjectEnvironment | undefined {
  if (!existsSync(path.join(workspace, '.git'))) return;
  const common = linkedWorktreeGitDirectories(workspace)[0];
  const repository = common ? path.dirname(common) : realpathSync(workspace);
  const config = path.join(repository, '.agent-platform', 'project-environment.json');
  let directory = path.join(repository, '.venv');
  if (existsSync(config)) {
    const value: unknown = JSON.parse(readFileSync(config, 'utf8'));
    if (!value || typeof value !== 'object' || !('pythonEnvironment' in value) || typeof value.pythonEnvironment !== 'string' || !value.pythonEnvironment.trim()) throw new Error('项目环境配置需要 pythonEnvironment 路径');
    directory = path.resolve(repository, value.pythonEnvironment);
  } else if (!existsSync(directory)) return;
  if (!existsSync(path.join(directory, 'bin', 'python')) || (!existsSync(path.join(directory, 'pyvenv.cfg')) && !existsSync(path.join(directory, 'conda-meta')))) throw new Error(`项目 Python 环境无效：${directory}，请修复项目配置；不会自动创建环境`);
  const canonical = realpathSync(directory);
  if (canonical !== directory) throw new Error(`项目环境配置请填写真实路径：${canonical}，避免虚拟环境入口失效`);
  return { repository, directory, env: { PATH: `${directory}/bin:${process.env.PATH || ''}`, VIRTUAL_ENV: directory,
    PYTHONPATH: '', PYTHONNOUSERSITE: '1', PIP_REQUIRE_VIRTUALENV: 'true', PYTHONDONTWRITEBYTECODE: '1' } };
}

/** Review runtimes use their pinned source checkouts; never choose between distinct environments. */
export function sandboxProjectEnvironment(workspace: string, readOnlyPaths: string[] = []) {
  const own = projectEnvironment(workspace);
  if (own) return own;
  const environments = readOnlyPaths.map(entry => projectEnvironment(entry)).filter((entry): entry is ProjectEnvironment => !!entry);
  const unique = Array.from(new Map(environments.map(entry => [entry.directory, entry])).values());
  if (unique.length > 1) throw new Error('本次验收涉及多个项目 Python 环境，需按仓库分别执行检查，不能隐式混用');
  return unique[0];
}
