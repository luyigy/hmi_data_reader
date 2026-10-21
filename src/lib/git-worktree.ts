import { execFile } from 'child_process';
import { workspacePath, workspaceSegment, workspaceIdentity } from './workspace-layout';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

/** List all git worktrees in the repo */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(18);
    } else if (line.startsWith('bare')) {
      current.bare = true;
    } else if (line === '') {
      if (current.path) {
        worktrees.push({ path: current.path, branch: current.branch || 'detached', head: current.head || '', bare: current.bare || false });
      }
      current = {};
    }
  }
  return worktrees;
}

/** Create a new worktree for task isolation */
export async function createWorktree(
  cwd: string,
  taskId: string,
  baseBranch?: string,
  purpose: 'development' | 'baselines' = 'development',
): Promise<string> {
  workspaceSegment(taskId);
  const registered = await listWorktrees(cwd);
  const branchName = `task/${workspaceIdentity(`${purpose}:${taskId}`)}`;
  const legacy = path.join(cwd, '.worktrees', taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32));
  const existing = registered.find(tree => tree.branch === branchName || purpose === 'development' && taskId === path.basename(legacy) && tree.path === legacy);
  if (existing) return existing.path;
  if (purpose === 'development' && await fs.lstat(legacy).then(() => true, () => false)) throw new Error('Legacy workspace identity is uncertain; preserve for inspection');
  const worktreeDir = await workspacePath(cwd, purpose, [taskId]);
  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
  const base = baseBranch ? (await execAsync('git', ['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`], { cwd })).stdout.trim() : 'HEAD';
  await execAsync('git', ['worktree', 'add', '-b', branchName, worktreeDir, base], { cwd });
  return worktreeDir;
}

/** Unproven Session/Writer references must be retained. Use the explicit workspace operations entrypoint. */
export async function removeWorktree(_cwd: string, _worktreePath: string): Promise<void> {
  throw new Error('Workspace removal requires fresh reference, Writer and saved-commit evidence');
}

export async function pruneWorktrees(_cwd: string): Promise<void> {
  throw new Error('Blind worktree pruning is disabled; inspect each registered path');
}

/** Get the current working directory's git root */
export async function getGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
  return stdout.trim();
}

/** Check if a path is inside a git worktree */
export async function isWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
