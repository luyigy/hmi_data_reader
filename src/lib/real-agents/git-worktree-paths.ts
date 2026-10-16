import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

const isLinkedWorktree = (workspace: string) => {
  const marker = path.join(workspace, '.git');
  return existsSync(marker) && lstatSync(marker).isFile();
};

export function workspaceGitDirectory(workspace: string) {
  if (!isLinkedWorktree(workspace)) return path.join(workspace, '.git');
  return execFileSync('git', ['-C', workspace, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
}

/** Linked worktrees keep their index, refs and objects outside the checkout. */
export function linkedWorktreeGitDirectories(workspace: string | undefined): string[] {
  if (!workspace || !isLinkedWorktree(workspace)) return [];
  const directory = workspaceGitDirectory(workspace);
  const common = execFileSync('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return Array.from(new Set([common, directory]));
}
