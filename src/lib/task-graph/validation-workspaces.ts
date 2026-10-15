import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const oid = /^[a-f0-9]{40,64}$/;
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

export type ValidationWorkspace = { repository: string; path: string; commit: string };

/** Pin every repository at one commit before any cross-repository check or review. */
export async function ensureValidationWorkspaces(args: {
  runId: string; nodeKey: string; commits: { repository: string; commit: string }[];
}): Promise<ValidationWorkspace[]> {
  const result: ValidationWorkspace[] = [];
  for (const entry of args.commits) {
    if (!oid.test(entry.commit)) throw new Error('Validation commit must be a full Git object ID');
    const repository = await realpath(entry.repository);
    if (await git(repository, 'rev-parse', '--show-toplevel') !== repository) {
      throw new Error(`Validation repository is not a Git root: ${repository}`);
    }
    if (await git(repository, 'rev-parse', '--verify', `${entry.commit}^{commit}`) !== entry.commit) {
      throw new Error(`Validation commit is missing: ${entry.commit}`);
    }
    const root = path.join(path.dirname(repository), '.agent-platform-task-graph-validations');
    const target = path.join(root, shortHash(args.runId), shortHash(args.nodeKey), shortHash(repository));
    const listing = await git(repository, 'worktree', 'list', '--porcelain');
    const registered = listing.split('\n\n').some((block) => block.split('\n').includes(`worktree ${target}`));
    if (!registered) {
      if (await lstat(target).then(() => true, () => false)) throw new Error(`Validation workspace path is occupied: ${target}`);
      await mkdir(path.dirname(target), { recursive: true });
      await git(repository, 'worktree', 'add', '--detach', target, entry.commit);
    }
    if (await git(target, 'rev-parse', 'HEAD') !== entry.commit ||
        await git(target, 'status', '--porcelain', '--untracked-files=all')) {
      throw new Error(`Validation workspace changed or is dirty: ${target}`);
    }
    result.push({ repository, path: target, commit: entry.commit });
  }
  return result;
}

export async function assertValidationWorkspacesClean(workspaces: ValidationWorkspace[]) {
  for (const workspace of workspaces) {
    if (await git(workspace.path, 'rev-parse', 'HEAD') !== workspace.commit ||
        await git(workspace.path, 'status', '--porcelain', '--untracked-files=all')) {
      throw new Error(`Validation workspace changed or is dirty: ${workspace.path}`);
    }
  }
}
