import { graphGit as git } from './git-command';
import { realpath } from 'node:fs/promises';

const oid = /^[a-f0-9]{40,64}$/;

export type ReviewWorkspace = { repository: string; path: string; commit: string };
type Execution = { repository: string; worktreePath: string | null; commit: string | null };

/** Reuse every job checkout for evidence; the tested combined checkout is last per repository. */
export async function resolveReviewWorkspaces(executions: Execution[]): Promise<ReviewWorkspace[]> {
  const groups = new Map<string, ReviewWorkspace[]>();
  for (const execution of executions) {
    if (!execution.worktreePath || !execution.commit || !oid.test(execution.commit)) throw new Error('Review requires a recorded worktree and integrated commit');
    const repository = await realpath(execution.repository);
    const directory = await realpath(execution.worktreePath);
    const common = await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (common !== await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw new Error('Review workspace belongs to another repository');
    const workspace = { repository, path: directory, commit: execution.commit };
    const siblings = groups.get(repository) || [];
    siblings.push(workspace);
    groups.set(repository, siblings);
  }
  const result: ReviewWorkspace[] = [];
  for (const siblings of Array.from(groups.values())) {
    let combined: ReviewWorkspace | undefined;
    for (const candidate of siblings) {
      let containsAll = true;
      for (const sibling of siblings) {
        if (!await git(candidate.repository, 'merge-base', '--is-ancestor', sibling.commit, candidate.commit).then(() => true, () => false)) containsAll = false;
      }
      if (containsAll) { combined = candidate; break; }
    }
    if (!combined) throw new Error('Repository executions do not have a tested combined workspace');
    result.push(...siblings.filter((workspace) => workspace !== combined), combined);
  }
  await assertReviewWorkspacesClean(result);
  return result;
}

export async function assertReviewWorkspacesClean(workspaces: ReviewWorkspace[]) {
  for (const workspace of workspaces) {
    if (await git(workspace.path, 'rev-parse', 'HEAD') !== workspace.commit ||
        await git(workspace.path, 'status', '--porcelain', '--untracked-files=all')) {
      throw new Error(`Review workspace changed or is dirty: ${workspace.path}`);
    }
  }
}
