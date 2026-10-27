import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { graphGit } from './task-graph/git-command';

export const workspaceIdentity = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const configuredWorkspaceRoot = () => process.env.AP_WORKSPACE_ROOT || path.join(homedir(), '.agent-platform', 'workspaces');

export function workspaceSegment(value: string): string {
  if (!value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid workspace identity');
  const label = value.normalize('NFKC').replace(new RegExp('[^\\p{L}\\p{N}_-]', 'gu'), '-').slice(0, 48) || 'workspace';
  return `${label}-${workspaceIdentity(value)}`;
}

/** Common Git identity is shared by linked checkouts, independent of the configured workspace root. */
export async function projectWorkspaceDirectory(repository: string): Promise<string> {
  const common = await fs.realpath(await graphGit(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  return `${workspaceSegment(path.basename(path.dirname(common)))}-${workspaceIdentity(common)}`;
}

export async function workspacePath(repository: string, purpose: 'development' | 'baselines' | 'routes' | 'readonly', identities: string[]): Promise<string> {
  const segments = identities.map(workspaceSegment);
  const root = configuredWorkspaceRoot();
  if (!path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) throw new Error('Workspace root must be absolute');
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const repo = await fs.realpath(await graphGit(repository, 'rev-parse', '--show-toplevel'));
  if (canonicalRoot === repo || canonicalRoot.startsWith(repo + path.sep)) throw new Error('Workspace root must be outside repository');
  let target = canonicalRoot;
  for (const segment of [await projectWorkspaceDirectory(repository), purpose, ...segments]) {
    target = path.join(target, segment);
    const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) throw new Error('Workspace path cannot contain symbolic links');
  }
  return target;
}

/** Recognize old configured roots too; changing the root cannot turn another Ticket into an extra repo. */
export function isCentralWorkspacePath(directory: string): boolean {
  const parts = directory.split(path.sep);
  return parts.some((part, index) => ['development', 'baselines', 'routes', 'readonly'].includes(part) && /-[0-9a-f]{16}-[0-9a-f]{16}$/.test(parts[index - 1] || ''));
}
