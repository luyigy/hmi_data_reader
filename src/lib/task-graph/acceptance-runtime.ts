import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { graphDependencyPaths } from './dependency-paths';
import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';
import type { ReviewWorkspace } from './review-workspaces';
import type { AcpxPermissionConfig } from '../acpx/types';

export function validationRuntimeDirectory(nodeId: string) {
  const root = process.env.TASK_GRAPH_VALIDATION_ROOT || path.join(homedir(), '.agent-platform', 'task-validation');
  if (!path.isAbsolute(root)) throw new Error('Validation runtime root must be absolute');
  return path.join(root, createHash('sha256').update(nodeId).digest('hex').slice(0, 24));
}

/** A writable test runtime beside readonly delivery workspaces; no additional Git checkout. */
export async function prepareAcceptanceRuntime(nodeId: string, attempt: string, workspaces: ReviewWorkspace[], recordedDirectory?: string) {
  const expected = path.join(validationRuntimeDirectory(nodeId), createHash('sha256').update(attempt).digest('hex').slice(0, 24));
  const directory = recordedDirectory || expected;
  if (path.dirname(directory) !== validationRuntimeDirectory(nodeId) || !/^[a-f0-9]{24}$/.test(path.basename(directory))) throw new Error('Acceptance runtime receipt is outside its node');
  if (!recordedDirectory) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) throw new Error('Acceptance runtime is redirected');
  const readOnlyPaths = Array.from(new Set(workspaces.flatMap(workspace => [workspace.path, ...linkedWorktreeGitDirectories(workspace.path), ...graphDependencyPaths(workspace.path)])));
  const permissionConfig: AcpxPermissionConfig = { profile: 'custom', sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [] };
  return { directory, readOnlyPaths, permissionConfig };
}
