import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectEnvironment, type ProjectEnvironment } from '../harness/project-environment';

/** Freeze environment selection and interpreter identity; host-managed packages must remain immutable. */
export function projectPythonRuntime(workspace: string) {
  const project = projectEnvironment(workspace);
  if (!project) return null;
  const hash = createHash('sha256').update(JSON.stringify({ repository: project.repository, directory: project.directory }));
  const interpreter = realpathSync(path.join(project.directory, 'bin/python'));
  if (statSync(interpreter).size > 64 * 1024 * 1024) throw new Error('Python 解释器超过摘要上限');
  hash.update(readFileSync(interpreter));
  for (const name of ['pyvenv.cfg', 'conda-meta/history']) {
    const file = path.join(project.directory, name);
    if (existsSync(file) && statSync(file).size > 1024 * 1024) throw new Error('Python 环境配置超过摘要上限');
    if (existsSync(file)) hash.update(name + '\0').update(readFileSync(file));
  }
  return { project, identity: hash.digest('hex') };
}

/** A multi-project sandbox exposes named environments without picking a global Python. */
export function pinnedSandboxPython(raw: string, readOnlyPaths: string[], primaryRepository?: string): ProjectEnvironment | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('固定项目 Python 环境清单无效');
  const projects = parsed.map((item): ProjectEnvironment => {
    if (!item || typeof item !== 'object' || typeof item.repository !== 'string' || typeof item.directory !== 'string' || !path.isAbsolute(item.directory) ||
      realpathSync(item.directory) !== item.directory || !readOnlyPaths.some(root => item.directory === root || item.directory.startsWith(root + path.sep))) throw new Error('固定项目 Python 环境超出挂载范围');
    return { repository: item.repository, directory: item.directory, env: { PATH: `${item.directory}/bin:${process.env.PATH || ''}`, VIRTUAL_ENV: item.directory,
      PYTHONPATH: '', PYTHONNOUSERSITE: '1', PIP_REQUIRE_VIRTUALENV: 'true', PYTHONDONTWRITEBYTECODE: '1' } };
  });
  if (primaryRepository) {
    const selected = projects.find(project => project.repository === primaryRepository);
    return selected;
  }
  const unique = Array.from(new Map(projects.map(project => [project.directory, project])).values());
  return unique.length === 1 ? unique[0] : undefined;
}
