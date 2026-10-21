import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { inventoryWorkspaces } from '../src/lib/workspace-operations';

async function main() {
  const repository = path.resolve(process.argv[2] || process.cwd());
  const registered = await inventoryWorkspaces(repository);
  const parent = path.dirname(repository);
  const visibleEntries = (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(parent, entry.name));
  console.log(JSON.stringify({ repository, observedAt: new Date().toISOString(), mode: 'read-only', registered,
    unclassified: visibleEntries.filter(directory => !registered.some(tree => tree.path === directory)).map(directory => ({ path: directory, reasons: ['Unclassified directory; ownership and references unknown; retained'] })) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
