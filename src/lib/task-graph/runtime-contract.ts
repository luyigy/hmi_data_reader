import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { graphGit } from './git-command';

export type RuntimeResource = { kind: 'path'; path: string; sha256: string } | { kind: 'output'; eventId: string; relativePath: string; sha256: string };
export type RuntimeDeclaration = { version: 1; browser?: { module: RuntimeResource; executable: RuntimeResource }; ocr?: { weights: RuntimeResource; requiredFiles: string[] } };
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function resource(value: unknown): RuntimeResource {
  const item = record(value);
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
  if (item.browser !== undefined) { const browser = record(item.browser); result.browser = { module: resource(browser.module), executable: resource(browser.executable) }; }
  if (item.ocr !== undefined) {
    const ocr = record(item.ocr);
    if (!Array.isArray(ocr.requiredFiles) || !ocr.requiredFiles.length || !ocr.requiredFiles.every((file: unknown) => typeof file === 'string' && file && !path.isAbsolute(file) && file.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'))) throw new Error('OCR 必需文件必须是权重目录内的相对路径');
    result.ocr = { weights: resource(ocr.weights), requiredFiles: ocr.requiredFiles };
  }
  return result;
}
export async function runtimeDeclaration(workspace: string) {
  const name = '.agent-platform/runtime.json';
  const filename = path.join(workspace, name);
  try { await fs.lstat(filename); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const tracked = await graphGit(workspace, 'ls-files', '-z', '--', name).catch(() => '');
    if (tracked) throw new Error('已版本化的运行能力声明在工作区中缺失');
    return null;
  }
  if (await fs.realpath(filename) !== filename || !(await fs.lstat(filename)).isFile()) throw new Error('运行能力声明不能是链接');
  if (!await graphGit(workspace, 'ls-files', '-z', '--', name)) throw new Error('运行能力声明必须纳入 Git 版本');
  const text = await graphGit(workspace, 'show', `HEAD:${name}`);
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
