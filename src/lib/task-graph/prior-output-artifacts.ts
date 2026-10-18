import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validationRuntimeDirectory } from './acceptance-runtime';
import { readValidationArchive } from './validation-results';

type OutputEvent = { id: string; payload: unknown };
export type PriorOutputArtifact = { eventId: string; directory: string; originalDirectory: string; archived: boolean };
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Original output identity is retained when physical evidence moves to its verified archive. */
export async function priorOutputArtifacts(nodeId: string, currentDirectory: string, outputs: OutputEvent[], archives: { payload: unknown }[]) {
  const owner = validationRuntimeDirectory(nodeId);
  const verified = new Map<string, ReturnType<typeof readValidationArchive>>();
  const result: PriorOutputArtifact[] = [];
  for (const event of outputs) {
    const original = record(event.payload).directory;
    if (typeof original !== 'string' || original === currentDirectory || !within(owner, original)) continue;
    const live = await fs.lstat(original).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (live) {
      if (!live.isDirectory() || await fs.realpath(original) !== original) throw new Error('Prior output directory is symlinked or invalid');
      result.push({ eventId: event.id, directory: original, originalDirectory: original, archived: false }); continue;
    }
    const relative = path.relative(owner, original);
    for (const receipt of archives) {
      const saved = record(receipt.payload);
      if (saved.source !== owner || typeof saved.directory !== 'string' || !Array.isArray(saved.deliveryCommits) || !saved.deliveryCommits.length) continue;
      if (!saved.deliveryCommits.every(commit => { const value = record(commit); return typeof value.executionId === 'string' && typeof value.commit === 'string' && /^[a-f0-9]{40,64}$/.test(value.commit); })) throw new Error('Invalid archived output delivery identity');
      let reading = verified.get(saved.directory);
      if (!reading) { reading = readValidationArchive(nodeId, saved.directory); verified.set(saved.directory, reading); }
      const archive = await reading;
      if (!archive.files.some(file => file.path.startsWith(relative + path.sep))) continue;
      const directory = path.join(archive.directory, 'files', relative);
      if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('Archived output directory is invalid');
      result.push({ eventId: event.id, directory, originalDirectory: original, archived: true }); break;
    }
  }
  return result;
}
