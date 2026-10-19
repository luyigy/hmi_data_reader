import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { graphGit } from './git-command';

export type RuntimeResource = { kind: 'path'; path: string; sha256: string } | { kind: 'output'; eventId: string; relativePath: string; sha256: string };
export type RuntimeDeclaration = { version: 1; browser?: { module: RuntimeResource; executable: RuntimeResource }; ocr?: { weights: RuntimeResource; requiredFiles: string[] } };
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function resource(value: unknown): RuntimeResource {
  const item = record(value);
  if (Object.keys(item).some(key => !(item.kind === 'output' ? ['kind', 'eventId', 'relativePath', 'sha256'] : ['kind', 'path', 'sha256']).includes(key))) throw new Error('运行资源存在未知字段');
  if (item.kind === 'output') {
    if (typeof item.eventId !== 'string' || !item.eventId || typeof item.relativePath !== 'string' || !item.relativePath || path.isAbsolute(item.relativePath) || item.relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('归档资源必须引用明确产物事件、相对路径和 SHA256');
    return { kind: 'output', eventId: item.eventId, relativePath: item.relativePath, sha256: item.sha256 };
  }
  if (item.kind !== undefined && item.kind !== 'path') throw new Error('未知运行资源来源');
  if (typeof item.path !== 'string' || !item.path.trim() || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('运行资源必须声明路径和 SHA256');
  return { kind: 'path', path: item.path, sha256: item.sha256 };
}
export function parseRuntimeDeclaration(value: unknown): RuntimeDeclaration {
  const item = record(value);
  if (item.version !== 1 || Object.keys(item).some(key => !['version', 'browser', 'ocr'].includes(key))) throw new Error('运行能力声明版本或字段无效');
  const result: RuntimeDeclaration = { version: 1 };
  if (item.browser !== undefined) { const browser = record(item.browser); if (Object.keys(browser).some(key => !['module', 'executable'].includes(key))) throw new Error('浏览器声明存在未知字段'); result.browser = { module: resource(browser.module), executable: resource(browser.executable) }; }
  if (item.ocr !== undefined) {
    const ocr = record(item.ocr);
    if (Object.keys(ocr).some(key => !['weights', 'requiredFiles'].includes(key))) throw new Error('OCR 声明存在未知字段');
    if (!Array.isArray(ocr.requiredFiles) || !ocr.requiredFiles.length || !ocr.requiredFiles.every((file: unknown) => typeof file === 'string' && file && !path.isAbsolute(file) && file.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'))) throw new Error('OCR 必需文件必须是权重目录内的相对路径');
    result.ocr = { weights: resource(ocr.weights), requiredFiles: ocr.requiredFiles };
  }
  return result;
}
export type RuntimeDeclarationSource = { origin?: 'project' | 'host_registration'; registrationHash?: string; declaration: RuntimeDeclaration; manifestHash: string; commit: string; filename: string };
export async function runtimeDeclaration(workspace: string): Promise<RuntimeDeclarationSource | null> {
  const name = '.agent-platform/runtime.json';
  const filename = path.join(workspace, name);
  const local = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!local) {
    let ancestor = workspace;
    while (true) {
      const marker = await fs.lstat(path.join(ancestor, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const head = marker?.isDirectory() ? await fs.lstat(path.join(ancestor, '.git/HEAD')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
      if (marker?.isFile() || head?.isFile() || marker && ancestor === workspace) break;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
  const gitRoot = await graphGit(workspace, 'rev-parse', '--show-toplevel');
  if (gitRoot !== workspace) { if (!local) return null; throw new Error('运行能力声明必须位于实际执行仓库根目录'); }
  let tracked: string;
  try { tracked = await graphGit(workspace, 'ls-tree', '--name-only', 'HEAD', '--', name); }
  catch (error) {
    if (local || !error || typeof error !== 'object' || Reflect.get(error, 'code') !== 128) throw error;
    const headFile = path.resolve(workspace, await graphGit(workspace, 'rev-parse', '--git-path', 'HEAD'));
    const direct = (await fs.readFile(headFile, 'utf8')).match(/^ref: (refs\/heads\/[^\r\n]+)\r?\n?$/)?.[1];
    const resolved = await graphGit(workspace, 'symbolic-ref', '--quiet', 'HEAD');
    if (!direct || direct !== resolved) throw error;
    try { await graphGit(workspace, 'show-ref', '--verify', '--quiet', direct); }
    catch (referenceError) {
      if (referenceError && typeof referenceError === 'object' && Reflect.get(referenceError, 'code') === 1) return null;
      throw referenceError;
    }
    throw error;
  }
  if (!tracked && !local) return null;
  if (!tracked) throw new Error('运行能力声明必须纳入 Git 版本');
  if (!local) throw new Error('已版本化的运行能力声明在工作区中缺失');
  if (await fs.realpath(filename) !== filename || !local.isFile()) throw new Error('运行能力声明不能是链接');
  const text = await graphGit(workspace, 'show', `HEAD:${name}`);
  if ((await fs.readFile(filename, 'utf8')).trimEnd() !== text) throw new Error('运行能力声明存在未提交改动，必须进入新的受控 claim 后重新固定');
  return { declaration: parseRuntimeDeclaration(JSON.parse(text)), manifestHash: createHash('sha256').update(text).digest('hex'), commit: await graphGit(workspace, 'rev-parse', 'HEAD'), filename };
}
/** Digest exactly the declared resource. Never follow a link to undeclared shared data. */
export async function runtimeResourceDigest(target: string) {
  const budget = { files: 0, bytes: 0 };
  const digestFile = async (filename: string) => {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || await fs.realpath(filename) !== filename) throw new Error(`资源包含链接或特殊文件：${filename}`);
    budget.files++; budget.bytes += stat.size;
    if (budget.files > 20_000 || budget.bytes > 512 * 1024 * 1024) throw new Error('运行资源超过摘要上限');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex');
  };
  const stat = await fs.lstat(target);
  if (stat.isFile()) return digestFile(target);
  if (!stat.isDirectory() || await fs.realpath(target) !== target) throw new Error('运行资源目录无效');
  const hash = createHash('sha256');
  const walk = async (directory: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else hash.update(path.relative(target, filename) + '\0' + await digestFile(filename) + '\0');
    }
  };
  await walk(target); return hash.digest('hex');
}
