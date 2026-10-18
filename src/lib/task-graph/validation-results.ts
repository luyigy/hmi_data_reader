import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validationRuntimeDirectory } from './acceptance-runtime';

type ArchivedLink = { path: string; target: string; resolved: string };
const within = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
type ArchivedFile = { path: string; sha256: string; bytes: number };
const caches = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exists = (directory: string) => fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function realDirectory(directory: string) {
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('Keep validation results: directory is symlinked or invalid');
}
async function collect(directory: string) {
  const files: ArchivedFile[] = [];
  const links: ArchivedLink[] = [];
  let bytes = 0;
  let skippedDirectories = 0;
  await realDirectory(directory);
  const walk = async (relative: string) => {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const key = path.join(relative, name);
      const full = path.join(directory, key);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(full);
        const candidate = path.resolve(path.dirname(full), target);
        if (!within(directory, candidate)) throw new Error(`Keep validation results: external symlink ${key}`);
        const resolved = await fs.realpath(candidate);
        if (!within(directory, resolved)) throw new Error(`Keep validation results: external symlink ${key}`);
        links.push({ path: key, target, resolved: path.relative(directory, resolved) });
        continue;
      }
      if (stat.isDirectory()) {
        if (caches.has(name)) skippedDirectories++;
        else await walk(key);
      } else {
        if (!stat.isFile()) throw new Error(`Keep validation results: unsupported file ${key}`);
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024 || files.length >= 10_000) throw new Error('Keep validation results: archive limit exceeded');
        files.push({ path: key, bytes: stat.size, sha256: digest(await fs.readFile(full)) });
      }
    }
  };
  await walk('');
  return { files, links, bytes, skippedDirectories };
}
function parseManifest(text: string, nodeId: string, source: string) {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('nodeId' in raw) || raw.nodeId !== nodeId || !('source' in raw) || raw.source !== source || !('files' in raw) || !Array.isArray(raw.files) || !('skippedDirectories' in raw) || typeof raw.skippedDirectories !== 'number') throw new Error('Validation archive identity differs');
  const files = raw.files.map((file: unknown): ArchivedFile => {
    if (!file || typeof file !== 'object' || !('path' in file) || typeof file.path !== 'string' || !file.path || path.isAbsolute(file.path) || file.path.split(path.sep).includes('..') || !('sha256' in file) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !('bytes' in file) || typeof file.bytes !== 'number' || file.bytes < 0) throw new Error('Invalid validation archive manifest');
    return { path: file.path, sha256: file.sha256, bytes: file.bytes };
  });
  const links: ArchivedLink[] = [];
  if ('links' in raw) {
    if (!Array.isArray(raw.links)) throw new Error('Invalid validation archive links');
    for (const link of raw.links) {
      if (!link || typeof link !== 'object' || !('path' in link) || typeof link.path !== 'string' || !('target' in link) || typeof link.target !== 'string' || !('resolved' in link) || typeof link.resolved !== 'string' || !within(source, path.resolve(source, link.path)) || !within(source, path.resolve(source, link.resolved))) throw new Error('Invalid validation archive links');
      links.push({ path: link.path, target: link.target, resolved: link.resolved });
    }
  }
  return { files, links, bytes: files.reduce((sum, file) => sum + file.bytes, 0), skippedDirectories: raw.skippedDirectories };
}
async function verifyFiles(directory: string, files: ArchivedFile[]) {
  for (const file of files) {
    const target = path.join(directory, 'files', file.path);
    const stat = await fs.lstat(target);
    if (await fs.realpath(target) !== target || !stat.isFile() || stat.size !== file.bytes || digest(await fs.readFile(target)) !== file.sha256) throw new Error(`Validation archive differs: ${file.path}`);
  }
}

/** Keep every acceptance attempt before deleting only this node's inactive runtime directory. */
export async function archiveValidationResults(nodeId: string, directory: string, canRemove = async () => true) {
  const source = validationRuntimeDirectory(nodeId);
  const relative = path.relative(source, directory);
  if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Validation archive must be outside runtime');
  const manifest = path.join(directory, 'manifest.json');
  if (!await exists(source)) {
    if (!await exists(manifest)) return { source, directory, manifest: null, files: 0, bytes: 0, skippedDirectories: 0, symlinks: 0 };
    await realDirectory(directory);
    if (await fs.realpath(manifest) !== manifest) throw new Error('Validation manifest is symlinked');
    const saved = parseManifest(await fs.readFile(manifest, 'utf8'), nodeId, source);
    await verifyFiles(directory, saved.files);
    return { source, directory, manifest, files: saved.files.length, bytes: saved.bytes, skippedDirectories: saved.skippedDirectories, symlinks: saved.links.length };
  }
  const snapshot = await collect(source);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await realDirectory(directory);
  for (const file of snapshot.files) {
    const target = path.join(directory, 'files', file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await realDirectory(path.dirname(target));
    try { await fs.writeFile(target, await fs.readFile(path.join(source, file.path)), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  await verifyFiles(directory, snapshot.files);
  const text = JSON.stringify({ version: 1, nodeId, source, ...snapshot });
  try { await fs.writeFile(manifest, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if (await fs.realpath(manifest) !== manifest || await fs.readFile(manifest, 'utf8') !== text) throw new Error('Validation archive manifest differs');
  }
  if (!await canRemove()) throw new Error('Keep validation results: active task');
  if (JSON.stringify(await collect(source)) !== JSON.stringify(snapshot)) throw new Error('Keep validation results: source changed during archive');
  await fs.rm(source, { recursive: true });
  return { source, directory, manifest, files: snapshot.files.length, bytes: snapshot.bytes, skippedDirectories: snapshot.skippedDirectories, symlinks: snapshot.links.length };
}

/** Read and verify archived evidence without creating, deleting or restoring runtime paths. */
export async function readValidationArchive(nodeId: string, directory: string) {
  const source = validationRuntimeDirectory(nodeId);
  await realDirectory(directory);
  const manifest = path.join(directory, 'manifest.json');
  if (await fs.realpath(manifest) !== manifest) throw new Error('Validation manifest is symlinked');
  const saved = parseManifest(await fs.readFile(manifest, 'utf8'), nodeId, source);
  await verifyFiles(directory, saved.files);
  return { source, directory, files: saved.files };
}
