import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { workspaceGitDirectory } from './git-worktree-paths';
import { homedir } from 'node:os';
import path from 'node:path';

export const SHARED_ENTRIES = ['auth.json', 'config.toml', 'skills', 'plugins', 'rules'];

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

export const resolvePlatformLocalCodexHome = (
  workspaceRoot: string | undefined,
  requestedHome?: string
) => workspaceRoot
  ? path.join(workspaceGitDirectory(workspaceRoot), 'agent-platform', 'codex', path.basename(requestedHome || 'session'))
  : requestedHome;
