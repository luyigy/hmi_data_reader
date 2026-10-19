import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseRuntimeDeclaration, type RuntimeDeclaration } from '../task-graph/runtime-contract';

export type TableSource = { key: string; baseToken: string; tableId: string; searchField: string; imageFields: string[]; viewId?: string };
export type ProjectCapabilityScope = { policyHash: string; sources: string[]; readOnlyRoots: string[] };
export type ProjectCapabilityPolicy = { repository: string; appId: string; principals: string[]; readOnlyRoots: string[]; sources: TableSource[]; runtime?: RuntimeDeclaration; hash: string };
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目能力配置必须是对象');
  return Object.fromEntries(Object.entries(value));
};
const text = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('项目能力配置文本无效'); return value; };
const texts = (value: unknown) => { if (!Array.isArray(value) || value.length > 100) throw new Error('项目能力配置列表无效'); return value.map(text); };
export const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/** This file is platform-admin controlled, never resolved relative to a task checkout. */
export async function projectCapabilityPolicy(repository: string, file = path.join(homedir(), '.agent-platform', 'project-capabilities.json')): Promise<ProjectCapabilityPolicy | null> {
  let raw: unknown;
  try {
    if (await fs.realpath(file) !== file) throw new Error('项目能力配置不能使用符号链接');
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  const config = object(raw);
  if (config.version !== 1 || !Array.isArray(config.projects)) throw new Error('项目能力配置版本无效');
  const entries = config.projects.map(object).filter(entry => entry.repository === repository);
  if (entries.length > 1) throw new Error('项目能力配置重复');
  if (!entries.length) return null;
  const entry = entries[0];
  if (await fs.realpath(repository) !== repository) throw new Error('项目必须使用主仓真实路径');
  if (Object.keys(entry).some(key => !['repository', 'appId', 'principals', 'readOnlyRoots', 'sources', 'runtime'].includes(key))) throw new Error('项目能力配置存在未知字段');
  const appId = text(entry.appId), principals = texts(entry.principals), readOnlyRoots = texts(entry.readOnlyRoots);
  if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !principals.length || principals.some(id => !/^platform:[^:]+$/.test(id) && !new RegExp(`^feishu:${appId}:ou_[a-zA-Z0-9]+$`).test(id))) throw new Error('项目能力主体或应用身份无效');
  for (const root of readOnlyRoots) {
    if (!path.isAbsolute(root) || root === '/' || await fs.realpath(root) !== root || !(await fs.stat(root)).isDirectory()) throw new Error('项目只读目录必须是真实目录');
  }
  if (!Array.isArray(entry.sources) || entry.sources.length > 30) throw new Error('资料源列表无效');
  const sources = entry.sources.map(value => {
    const source = object(value);
    if (Object.keys(source).some(key => !['key', 'baseToken', 'tableId', 'searchField', 'imageFields', 'viewId'].includes(key))) throw new Error('资料源存在未知字段');
    const key = text(source.key), baseToken = text(source.baseToken), tableId = text(source.tableId);
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(key) || !/^[a-zA-Z0-9]+$/.test(baseToken) || !/^tbl[a-zA-Z0-9]+$/.test(tableId)) throw new Error('资料源身份无效');
    const imageFields = texts(source.imageFields);
    if (!imageFields.length) throw new Error('资料源须限定图片字段');
    return { key, baseToken, tableId, searchField: text(source.searchField), imageFields, ...(source.viewId === undefined ? {} : { viewId: text(source.viewId) }) };
  });
  if (new Set(sources.map(source => source.key)).size !== sources.length) throw new Error('资料源别名重复');
  return { repository, appId, principals, readOnlyRoots, sources, ...(entry.runtime === undefined ? {} : { runtime: parseRuntimeDeclaration(entry.runtime) }),
    hash: createHash('sha256').update(JSON.stringify(entry)).digest('hex') };
}

export function authorizeProjectCapabilities(policy: ProjectCapabilityPolicy, principals: string[], appId = process.env.FEISHU_APP_ID) {
  if (policy.appId !== appId || !principals.length || principals.some(id => !policy.principals.includes(id))) throw new Error('当前任务或消息作者未获项目能力授权');
}

export function restrictProjectCapabilities(policy: ProjectCapabilityPolicy, value: unknown): ProjectCapabilityPolicy {
  const scope = parseProjectCapabilityScope(value);
  const sources = scope.sources, roots = scope.readOnlyRoots;
  if (scope.policyHash !== policy.hash || sources.some(key => !policy.sources.some(source => source.key === key)) || roots.some(root => !policy.readOnlyRoots.includes(root))) throw new Error('任务获批能力与当前项目授权不匹配，须核对路线授权');
  return { ...policy, sources: policy.sources.filter(source => sources.includes(source.key)), readOnlyRoots: roots };
}

export function parseProjectCapabilityScope(value: unknown): ProjectCapabilityScope {
  const scope = object(value);
  if (Object.keys(scope).some(key => !['policyHash', 'sources', 'readOnlyRoots'].includes(key)) || typeof scope.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(scope.policyHash)) throw new Error('任务能力范围无效');
  const sources = texts(scope.sources), readOnlyRoots = texts(scope.readOnlyRoots);
  if (sources.some(key => !/^[a-z][a-z0-9_-]{0,40}$/.test(key)) || readOnlyRoots.some(root => !path.isAbsolute(root) || root === '/')) throw new Error('任务能力资源范围无效');
  return { policyHash: scope.policyHash, sources, readOnlyRoots };
}
