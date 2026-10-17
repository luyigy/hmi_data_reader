import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Registered local tool installations are readable, never writable, inside restricted runs. */
export function localToolchainPaths() {
  const home = homedir();
  return Array.from(new Set([
    path.dirname(path.dirname(process.execPath)),
    path.join(home, '.local', 'bin'), path.join(home, '.local', 'share', 'uv', 'tools'),
    path.join(home, 'anaconda3'), path.join(home, 'miniconda3'), path.join(home, '.kimi-code', 'bin'),
  ].filter(existsSync).map((entry) => realpathSync(entry))));
}
