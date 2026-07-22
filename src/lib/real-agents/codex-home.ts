import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SHARED_ENTRIES = ['auth.json', 'config.toml', 'skills', 'plugins', 'rules'];

export const prepareCodexHome = (
  codexHome: string,
  sharedHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
) => {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (path.resolve(codexHome) === path.resolve(sharedHome)) return;

  for (const entry of SHARED_ENTRIES) {
    const source = path.join(sharedHome, entry);
    const target = path.join(codexHome, entry);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target, lstatSync(source).isDirectory() ? 'dir' : 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
};
