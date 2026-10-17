import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IssueRouteSettings } from './issue-route';

const execute = promisify(execFile);
export type SpecPackageRef = { repository: string; commit: string; manifestPath: string; hash: string };
export type SpecPackage = SpecPackageRef & { title: string; specPath: string; routePath?: string; issueRoute?: IssueRouteSettings;
  artifacts: { path: string; content: Buffer }[] };

async function git(repository: string, ...args: string[]) {
  return (await execute('git', args, { cwd: repository, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function packageFile(directory: string, value: unknown) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) throw new Error('Spec 包文件路径无效');
  const result = path.posix.normalize(path.posix.join(directory, value));
  if (!result.startsWith(`${directory}/`)) throw new Error('Spec 包文件不能越出目录');
  return result;
}

export async function loadSpecPackage(repository: string, commit: string, manifestPath: string): Promise<SpecPackage | null> {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^docs\/specs\/[^\n]+\/spec-package\.json$/.test(manifestPath)
    || path.posix.normalize(manifestPath) !== manifestPath) throw new Error('Spec 包引用无效');
  const manifestText = await git(repository, 'show', `${commit}:${manifestPath}`);
  const manifest: unknown = JSON.parse(manifestText);
  if (!record(manifest) || typeof manifest.title !== 'string' || !manifest.title.trim()) throw new Error(`Spec 包标题无效：${manifestPath}`);
  if (manifest.status !== 'ready') return null;
  const directory = path.posix.dirname(manifestPath);
  const specPath = packageFile(directory, manifest.spec);
  const routePath = manifest.route ? packageFile(directory, manifest.route) : undefined;
  if (!!routePath === !!manifest.issueRoute) throw new Error('Spec 包只可指定 Issue 路线或历史 JSON 路线之一');
  if (!specPath.endsWith('.md') || (routePath && !routePath.endsWith('.json')) || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length > 6) throw new Error('Spec 包必须指定 MD Spec、Issue 路线和不超过 6 个附件');
  let issueRoute: IssueRouteSettings | undefined;
  if (manifest.issueRoute) {
    if (!record(manifest.issueRoute) || typeof manifest.issueRoute.parent !== 'string' || (!record(manifest.issueRoute.slices) && !record(manifest.issueRoute.existingRun)) ||
      (record(manifest.issueRoute.slices) && record(manifest.issueRoute.existingRun))) throw new Error('Spec 包 Issue 执行配置无效');
    issueRoute = manifest.issueRoute as IssueRouteSettings;
  }
  const artifactPaths = Array.from(new Set([specPath, ...manifest.artifacts.map((value) => packageFile(directory, value))]));
  if (artifactPaths.some((file) => !/\.(html|md)$/.test(file))) throw new Error('提审附件只支持 HTML/MD');
  const hash = createHash('sha256').update(manifestText);
  const artifacts: SpecPackage['artifacts'] = [];
  for (const file of Array.from(new Set([...artifactPaths, ...(routePath ? [routePath] : [])])).sort()) {
    const content = Buffer.from(await git(repository, 'show', `${commit}:${file}`));
    if (!content.length || content.length > 2 * 1024 * 1024) throw new Error(`Spec 包文件为空或超过 2 MB：${file}`);
    hash.update(file).update('\0').update(content);
    if (artifactPaths.includes(file)) artifacts.push({ path: file, content });
  }
  return { repository, commit, manifestPath, hash: hash.digest('hex'), title: manifest.title,
    specPath, ...(routePath ? { routePath } : {}), ...(issueRoute ? { issueRoute } : {}), artifacts };
}

export async function listSpecPackages(repository: string) {
  const commit = (await git(repository, 'rev-parse', 'HEAD')).trim();
  const files = (await git(repository, 'ls-tree', '-r', '-z', '--name-only', commit, '--', 'docs/specs')).split('\0');
  const packages: SpecPackage[] = [];
  for (const file of files.filter((file) => file.endsWith('/spec-package.json'))) {
    const item = await loadSpecPackage(repository, commit, file);
    if (item) packages.push(item);
  }
  return { commit, packages };
}

export async function assertSpecPackage(ref: SpecPackageRef | undefined) {
  if (!ref) return;
  const item = await loadSpecPackage(ref.repository, ref.commit, ref.manifestPath);
  if (!item || item.hash !== ref.hash) throw new Error('Spec 包版本或内容哈希不匹配，请重新提审');
  return item;
}
