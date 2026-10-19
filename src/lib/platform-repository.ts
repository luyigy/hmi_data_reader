import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Resolve platform-owned files from this module, independently of the launch or task directory. */
export function platformRepository() {
  let directory = __dirname;
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (value && typeof value === 'object' && 'name' in value && value.name === 'agent-platform-v2') return realpathSync(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the platform package from its installed module');
    directory = parent;
  }
}
