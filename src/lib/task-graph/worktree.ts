import { graphGit as git } from './git-command';
import { preserveWorktreeResults } from './worktree-results';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const oidPattern = /^[0-9a-f]{40,64}$/;

type Worktree = { path: string; head: string; branch?: string };

export class TaskGraphGitError extends Error {
  constructor(
    public readonly code: 'invalid_repository' | 'invalid_ref' | 'invalid_base' | 'workspace_collision' |
      'workspace_dirty' | 'integration_checked_out' | 'integration_stale' | 'integration_conflict' |
      'verification_failed' | 'not_integrated',
    message: string,
    public readonly workspacePath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TaskGraphGitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface JobWorktreeRequest {
  repoPath: string;
  runId: string;
  jobId: string;
  baseRef: string;
  baseCommit: string;
  worktreeRoot?: string;
}

export interface JobWorktree {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface IntegrationRefRequest {
  repoPath: string;
  runId: string;
  baseRef: string;
  baseCommit: string;
}

export interface IntegrationRequest {
  repoPath: string;
  runId: string;
  jobId: string;
  integrationRef: string;
  expectedIntegrationCommit: string;
  baseCommit: string;
  worktreeRoot?: string;
  verify: (jobPath: string) => Promise<void>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);



async function succeeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

async function repositoryRoot(repoPath: string): Promise<string> {
  let root: string;
  try {
    root = await git(repoPath, 'rev-parse', '--show-toplevel');
  } catch (cause) {
    throw new TaskGraphGitError('invalid_repository', `Not a Git working repository: ${repoPath}`, undefined, { cause });
  }
  if (path.resolve(repoPath) !== path.resolve(root)) {
    throw new TaskGraphGitError('invalid_repository', `Expected repository root: ${root}`);
  }
  return fs.realpath(root);
}

function requireOid(commit: string): void {
  if (!oidPattern.test(commit)) {
    throw new TaskGraphGitError('invalid_base', `Expected a full Git commit ID: ${commit}`);
  }
}

function requireBranchRef(ref: string): void {
  if (!ref.startsWith('refs/heads/') || ref.includes('..') || ref.includes('@{') || /[\s~^:?*\\\[]/.test(ref)) {
    throw new TaskGraphGitError('invalid_ref', `Expected a full branch ref: ${ref}`);
  }
}

async function exactCommit(repo: string, commit: string): Promise<string> {
  requireOid(commit);
  const actual = await git(repo, 'rev-parse', '--verify', `${commit}^{commit}`).catch(() => '');
  if (actual !== commit) {
    throw new TaskGraphGitError('invalid_base', `Commit does not exist in repository: ${commit}`);
  }
  return actual;
}

async function refCommit(repo: string, ref: string): Promise<string | undefined> {
  requireBranchRef(ref);
  const result = await git(repo, 'show-ref', '--verify', '--hash', ref).catch(() => '');
  return result || undefined;
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return succeeds(repo, 'merge-base', '--is-ancestor', ancestor, descendant);
}

async function worktrees(repo: string): Promise<Worktree[]> {
  const output = await git(repo, 'worktree', 'list', '--porcelain');
  return output.split(/\n\n/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    return {
      path: lines.find((line) => line.startsWith('worktree '))?.slice(9) || '',
      head: lines.find((line) => line.startsWith('HEAD '))?.slice(5) || '',
      branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
    };
  });
}

async function workspaceRoot(repo: string, requested?: string): Promise<string> {
  const root = requested || path.join(path.dirname(repo), '.agent-platform-task-graph-worktrees');
  if (!path.isAbsolute(root) || root.includes('\n')) {
    throw new TaskGraphGitError('workspace_collision', 'Worktree root must be an absolute path without newlines');
  }
  await fs.mkdir(root, { recursive: true });
  const real = await fs.realpath(root);
  const relative = path.relative(repo, real);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new TaskGraphGitError('workspace_collision', 'Worktree root must be outside the repository');
  }
  return real;
}

function jobBranch(runId: string, jobId: string): string {
  return `refs/heads/task-graph/jobs/${hash(runId)}/${hash(jobId)}`;
}

function integrationBranch(runId: string): string {
  return `refs/heads/task-graph/integration/${hash(runId)}`;
}

function jobPath(root: string, repo: string, runId: string, jobId: string): string {
  return path.join(root, hash(repo), hash(runId), 'jobs', hash(jobId));
}

async function assertUnoccupied(repo: string, target: string): Promise<void> {
  if ((await worktrees(repo)).some((tree) => tree.path === target)) return;
  if (await fs.lstat(target).then(() => true, () => false)) {
    throw new TaskGraphGitError('workspace_collision', `Path exists outside Git worktree registry: ${target}`, target);
  }
}

function findWorkspace(trees: Worktree[], target: string): Worktree | undefined {
  return trees.find((tree) => tree.path === target);
}

async function cleanWorkspace(target: string): Promise<boolean> {
  return (await git(target, 'status', '--porcelain', '--untracked-files=all')) === '';
}

async function hasIgnoredFiles(target: string): Promise<boolean> {
  return (await git(target, 'ls-files', '--others', '--ignored', '--exclude-standard')) !== '';
}

/** Make a per-run integration ref without moving or checking out the source branch. */
export async function ensureIntegrationRef(request: IntegrationRefRequest): Promise<{ ref: string; commit: string }> {
  const repo = await repositoryRoot(request.repoPath);
  await exactCommit(repo, request.baseCommit);
  const source = await refCommit(repo, request.baseRef);
  if (!source || !(await isAncestor(repo, request.baseCommit, source))) {
    throw new TaskGraphGitError('invalid_base', 'Base commit is not in the source branch history');
  }
  const ref = integrationBranch(request.runId);
  let commit = await refCommit(repo, ref);
  if (!commit) {
    await git(repo, 'update-ref', ref, request.baseCommit, '0'.repeat(request.baseCommit.length)).catch(async (cause) => {
      if (!(await refCommit(repo, ref))) throw cause;
    });
    commit = await refCommit(repo, ref);
  }
  if (!commit || !(await isAncestor(repo, request.baseCommit, commit))) {
    throw new TaskGraphGitError('invalid_base', `Integration ref diverged from its base: ${ref}`);
  }
  return { ref, commit };
}

/** A stable run/job identity produces one isolated checkout; repeated calls recover it. */
export async function ensureJobWorktree(request: JobWorktreeRequest): Promise<JobWorktree> {
  const repo = await repositoryRoot(request.repoPath);
  await exactCommit(repo, request.baseCommit);
  const branch = jobBranch(request.runId, request.jobId);
  const root = await workspaceRoot(repo, request.worktreeRoot);
  const target = jobPath(root, repo, request.runId, request.jobId);
  const registered = findWorkspace(await worktrees(repo), target);
  if (registered) {
    if (registered.branch !== branch || !(await isAncestor(repo, request.baseCommit, registered.head))) {
      throw new TaskGraphGitError('workspace_collision', `Existing worktree does not match job identity: ${target}`, target);
    }
    return { path: target, branch, baseCommit: request.baseCommit };
  }
  await assertUnoccupied(repo, target);
  const base = await refCommit(repo, request.baseRef);
  if (base !== request.baseCommit) {
    throw new TaskGraphGitError('invalid_base', `Base ref moved; expected ${request.baseCommit}, found ${base || 'missing'}`);
  }
  const existingBranch = await refCommit(repo, branch);
  if (existingBranch && existingBranch !== request.baseCommit) {
    throw new TaskGraphGitError('workspace_collision', `Detached job branch has changes: ${branch}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    if (existingBranch) await git(repo, 'worktree', 'add', target, branch);
    else await git(repo, 'worktree', 'add', '-b', branch.slice('refs/heads/'.length), target, request.baseCommit);
  } catch (cause) {
    const concurrent = findWorkspace(await worktrees(repo), target);
    if (!concurrent || concurrent.branch !== branch || !(await isAncestor(repo, request.baseCommit, concurrent.head))) {
      throw new TaskGraphGitError('workspace_collision', `Could not create job worktree: ${target}`, target, { cause });
    }
  }
  return { path: target, branch, baseCommit: request.baseCommit };
}

async function assertIntegrationNotCheckedOut(repo: string, ref: string): Promise<void> {
  const occupying = (await worktrees(repo)).find((tree) => tree.branch === ref);
  if (occupying) {
    throw new TaskGraphGitError('integration_checked_out', `Integration ref is checked out: ${ref}`, occupying.path);
  }
}

/** Merge the latest integration baseline into the job, verify there, then advance the ref. */
export async function integrateJobWorktree(request: IntegrationRequest): Promise<{ commit: string; alreadyIntegrated: boolean }> {
  const repo = await repositoryRoot(request.repoPath);
  await exactCommit(repo, request.expectedIntegrationCommit);
  await exactCommit(repo, request.baseCommit);
  requireBranchRef(request.integrationRef);
  if (request.integrationRef !== integrationBranch(request.runId)) {
    throw new TaskGraphGitError('invalid_ref', 'Integration ref does not match run identity');
  }
  await assertIntegrationNotCheckedOut(repo, request.integrationRef);
  const root = await workspaceRoot(repo, request.worktreeRoot);
  const job = jobPath(root, repo, request.runId, request.jobId);
  const branch = jobBranch(request.runId, request.jobId);
  const currentJob = findWorkspace(await worktrees(repo), job);
  if (!currentJob || currentJob.branch !== branch || !(await isAncestor(repo, request.baseCommit, currentJob.head))) {
    throw new TaskGraphGitError('workspace_collision', `Job worktree is missing or mismatched: ${job}`, job);
  }
  const gitDir = await git(job, 'rev-parse', '--absolute-git-dir');
  if (await fs.access(path.join(gitDir, 'MERGE_HEAD')).then(() => true, () => false)) {
    throw new TaskGraphGitError('integration_conflict', `Merge conflict needs resolution: ${job}`, job);
  }
  if (!(await cleanWorkspace(job))) {
    throw new TaskGraphGitError('workspace_dirty', `Job worktree has uncommitted changes: ${job}`, job);
  }
  const current = await refCommit(repo, request.integrationRef);
  if (!current) throw new TaskGraphGitError('invalid_ref', `Integration ref is missing: ${request.integrationRef}`);
  const alreadyIntegrated = await isAncestor(repo, currentJob.head, current);
  if (!alreadyIntegrated && current !== request.expectedIntegrationCommit) {
    throw new TaskGraphGitError('integration_stale', `Integration ref moved from ${request.expectedIntegrationCommit} to ${current}`);
  }
  if (!(await isAncestor(repo, request.baseCommit, current))) {
    throw new TaskGraphGitError('invalid_base', 'Integration ref diverged from job base');
  }
  if (!(await isAncestor(repo, current, currentJob.head))) {
    try {
      // Existing runs may have a merge commit from the retired staging checkout.
      if (alreadyIntegrated) await git(job, 'merge', '--ff-only', current);
      else await git(job, 'merge', '--no-ff', '--no-edit', current);
    } catch (cause) {
      throw new TaskGraphGitError('integration_conflict', `Merge needs manual resolution: ${job}`, job, { cause });
    }
  }
  const result = await git(job, 'rev-parse', 'HEAD');
  if (!(await isAncestor(repo, currentJob.head, result)) || !(await isAncestor(repo, current, result))) {
    throw new TaskGraphGitError('workspace_collision', `Job excludes its delivery or integration baseline: ${job}`, job);
  }
  try { await request.verify(job); } catch (cause) {
    throw new TaskGraphGitError('verification_failed', `Integration verification failed: ${job}\n${cause instanceof Error ? cause.message : String(cause)}`, job, { cause });
  }
  if (!(await cleanWorkspace(job))) {
    throw new TaskGraphGitError('verification_failed', `Verification left changes in job worktree: ${job}`, job);
  }
  if ((await refCommit(repo, branch)) !== result || (await refCommit(repo, request.integrationRef)) !== current) {
    throw new TaskGraphGitError('integration_stale', `Integration or job ref moved during verification: ${job}`, job);
  }
  if (result !== current) {
    try { await git(repo, 'update-ref', request.integrationRef, result, current); } catch (cause) {
      throw new TaskGraphGitError('integration_stale', `Integration ref changed before update: ${request.integrationRef}`, job, { cause });
    }
  }
  return { commit: result, alreadyIntegrated };
}

/** Platform-owned commit step. Native agents never receive writable shared Git metadata. */
export async function commitJobWorktree(request: Omit<JobWorktreeRequest, 'baseRef' | 'baseCommit'> & { message: string }): Promise<string> {
  const repo = await repositoryRoot(request.repoPath);
  const target = jobPath(await workspaceRoot(repo, request.worktreeRoot), repo, request.runId, request.jobId);
  const branch = jobBranch(request.runId, request.jobId);
  const tree = findWorkspace(await worktrees(repo), target);
  if (!tree || tree.branch !== branch || await git(target, 'symbolic-ref', 'HEAD') !== branch ||
      await git(target, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')) {
    throw new TaskGraphGitError('workspace_collision', 'Controlled commit requires the registered task branch', target);
  }
  const gitDirectory = await git(target, 'rev-parse', '--absolute-git-dir');
  if (await fs.access(path.join(gitDirectory, 'MERGE_HEAD')).then(() => true, () => false)) throw new TaskGraphGitError('integration_conflict', 'Resolve the pending merge before committing', target);
  await git(target, 'add', '--all', '--', '.');
  const staged = await git(target, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only');
  if (staged) await git(target, '-c', 'commit.gpgsign=false', '-c', 'user.name=Agent Platform', '-c', 'user.email=agent-platform@localhost',
    'commit', '-m', request.message.slice(0, 160));
  return git(target, 'rev-parse', 'HEAD');
}

/** Never force-remove: only a clean job tree whose head reached the integration ref can be removed. */
export async function cleanupIntegratedJobWorktree(request: Omit<JobWorktreeRequest, 'baseRef' | 'baseCommit'> & { integrationRef: string; expectedCommit?: string; resultsDirectory?: string }): Promise<void> {
  const repo = await repositoryRoot(request.repoPath);
  requireBranchRef(request.integrationRef);
  if (request.integrationRef !== integrationBranch(request.runId)) {
    throw new TaskGraphGitError('invalid_ref', 'Integration ref does not match run identity');
  }
  const root = await workspaceRoot(repo, request.worktreeRoot);
  const target = jobPath(root, repo, request.runId, request.jobId);
  const branch = jobBranch(request.runId, request.jobId);
  const tree = findWorkspace(await worktrees(repo), target);
  const jobHead = tree?.head || await refCommit(repo, branch);
  if (!jobHead) return;
  if (request.expectedCommit && jobHead !== request.expectedCommit) throw new TaskGraphGitError('workspace_dirty', 'Completed worktree moved; keep it for review', target);
  const integratedHead = await refCommit(repo, request.integrationRef);
  if (!integratedHead || !(await isAncestor(repo, jobHead, integratedHead))) {
    throw new TaskGraphGitError('not_integrated', `Job has not reached integration ref: ${branch}`, target);
  }
  if (tree) {
    if (tree.branch !== branch) throw new TaskGraphGitError('workspace_collision', `Worktree branch changed: ${target}`, target);
    if (!(await cleanWorkspace(target))) throw new TaskGraphGitError('workspace_dirty', `Worktree is dirty: ${target}`, target);
    if (await hasIgnoredFiles(target)) {
      if (!request.resultsDirectory) throw new TaskGraphGitError('workspace_dirty', `Worktree contains ignored files; keep it for review: ${target}`, target);
      await preserveWorktreeResults(target, request.resultsDirectory, jobHead);
    }
    if (!(await cleanWorkspace(target)) || await hasIgnoredFiles(target) || await git(target, 'rev-parse', 'HEAD') !== jobHead) {
      throw new TaskGraphGitError('workspace_dirty', `Worktree changed during cleanup: ${target}`, target);
    }
    await git(repo, 'worktree', 'remove', target);
  }
  await git(repo, 'update-ref', '-d', branch, jobHead);
}
