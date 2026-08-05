import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

/** List all git worktrees in the repo */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execAsync('git worktree list --porcelain', { cwd });
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(14);
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
): Promise<string> {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const worktreeDir = path.join(cwd, '.worktrees', safeId);
  const branchName = `task/${safeId}-${Date.now()}`;

  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

  if (baseBranch) {
    await execAsync(`git worktree add -b ${branchName} "${worktreeDir}" "${baseBranch}"`, { cwd });
  } else {
    await execAsync(`git worktree add -b ${branchName} "${worktreeDir}"`, { cwd });
  }

  return worktreeDir;
}

/** Remove a worktree and its branch */
export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd });
  } catch (error) {
    // Try pruning if remove fails
    await execAsync(`git worktree prune`, { cwd });
  }

  // Clean up the directory
  try {
    await fs.rm(worktreePath, { recursive: true, force: true });
  } catch {
    // directory may already be gone
  }
}

/** Prune stale worktree references */
export async function pruneWorktrees(cwd: string): Promise<void> {
  await execAsync('git worktree prune', { cwd });
}

/** Get the current working directory's git root */
export async function getGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
  return stdout.trim();
}

/** Check if a path is inside a git worktree */
export async function isWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
