import { existsSync, lstatSync, mkdirSync, symlinkSync, realpathSync, readlinkSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
    if (!existsSync(source)) continue;
    const canonicalSource = realpathSync(source);
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() && realpathSync(target) === canonicalSource && readlinkSync(target) !== canonicalSource) {
        const temporary = `${target}.${randomUUID()}.link`;
        symlinkSync(canonicalSource, temporary);
        renameSync(temporary, target);
      }
      continue;
    }
    try {
      symlinkSync(canonicalSource, target, lstatSync(canonicalSource).isDirectory() ? 'dir' : 'file');
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

export const sharedCodexAuthPath = ({ runtimeHome, codexHome }: { runtimeHome?: string; codexHome?: string }) => {
  const sharedAuth = runtimeHome && codexHome ? path.join(codexHome, 'auth.json') : null;
  return sharedAuth && existsSync(sharedAuth) ? realpathSync(sharedAuth) : null;
};

export const codexSandboxConfigPaths = (options: { runtimeHome?: string; codexHome?: string }) => {
  const paths = [options.runtimeHome || options.codexHome || process.env.CODEX_HOME || `${process.env.HOME}/.codex`];
  const sharedAuth = sharedCodexAuthPath(options);
  if (sharedAuth) paths.push(sharedAuth);
  return paths;
};
