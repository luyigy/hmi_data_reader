import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { graphGit as git } from './git-command';
import { inspectJobWorktree, type JobWorktreeRequest } from './worktree';
import type { IntegrationConflict } from './integration-failure';
import { prisma } from '../prisma';

export type ConflictRepair = {
  candidateCommit: string; integrationCommit: string; mergeHead: string; paths: string[];
  indexOutside: string; worktreeOutside: string;
  originals: Record<string, string>; stages: Record<string, string>;
};
type RepairRequest = Omit<JobWorktreeRequest, 'baseRef'> & {
  integrationRef: string; assertOwnership: () => Promise<void>;
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const oid = /^[a-f0-9]{40,64}$/;
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  !path.isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.agent-platform', '.gitattributes', '.gitmodules'].includes(part));

export function parseConflictRepair(value: unknown): ConflictRepair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conflict repair checkpoint');
  const v = value as Record<string, unknown>;
  if (![v.candidateCommit, v.integrationCommit, v.mergeHead].every(item => typeof item === 'string' && oid.test(item)) ||
      !Array.isArray(v.paths) || !v.paths.length || !v.paths.every(safePath) || new Set(v.paths).size !== v.paths.length ||
      ![v.indexOutside, v.worktreeOutside].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) throw new Error('Invalid conflict repair identity');
  for (const name of ['originals', 'stages']) {
    const entries = v[name];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).sort().join('\0') !== [...v.paths].sort().join('\0') ||
        !Object.values(entries).every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) throw new Error('Invalid conflict repair fingerprints');
  }
  return v as ConflictRepair;
}

export async function approvedConflictCommits(runId: string, repository: string): Promise<string[]> {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId }, repository }, select: { id: true, baseCommit: true } });
  const ids = new Set(jobs.map(job => job.id));
  const events = await prisma.taskGraphEvent.findMany({ where: { runId, kind: { in: ['execution_outcome', 'execution_integrated'] } }, select: { payload: true } });
  const commits = new Set(jobs.map(job => job.baseCommit));
  for (const { payload } of events) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.executionId !== 'string' || !ids.has(payload.executionId)) continue;
    const outcome = payload.outcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) continue;
    const commit = outcome.kind === 'integrated' ? outcome.commit : outcome.kind === 'checkpoint' ? outcome.candidateCommit : undefined;
    if (typeof commit === 'string' && oid.test(commit)) commits.add(commit);
  }
  return Array.from(commits);
}

async function regularFile(workspace: string, name: string) {
  if (!safePath(name)) throw new Error('Conflict repair paths are outside scope');
  const target = path.join(workspace, name);
  if (await fs.realpath(target) !== target || !(await fs.lstat(target)).isFile()) throw new Error(`Conflict repair requires a regular file: ${name}`);
  return target;
}
async function outside(workspace: string, paths: string[]) {
  const entries = (await git(workspace, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  const indexOutside = digest(entries.filter(entry => !paths.includes(entry.slice(entry.indexOf('\t') + 1))).join('\0'));
  const differences = await git(workspace, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.', ...paths.map(name => `:(literal,exclude)${name}`));
  const untracked = (await git(workspace, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean).sort();
  const contents = await Promise.all(untracked.map(async name => [name, digest(await fs.readFile(await regularFile(workspace, name)))]));
  return { indexOutside, worktreeOutside: digest(JSON.stringify([differences, contents])) };
}
async function stages(workspace: string, name: string) {
  return git(workspace, 'ls-files', '--stage', '-z', '--', `:(literal)${name}`);
}
async function assertProvenance(repo: string, base: string, heads: string[], approved: string[]) {
  const known = new Set(approved);
  for (const head of heads) {
    await git(repo, 'merge-base', '--is-ancestor', base, head);
    const commits = (await git(repo, 'rev-list', head, `^${base}`)).split('\n').filter(Boolean);
    if (commits.some(commit => !known.has(commit))) throw new Error('Conflict repair provenance includes an unapproved commit');
  }
}

export async function assertConflictIntegrationBaseline(request: Pick<RepairRequest, 'repoPath' | 'runId' | 'baseCommit' | 'integrationRef'> & { checkpoint: ConflictRepair; approvedCommits: string[] }) {
  if (request.integrationRef !== `refs/heads/task-graph/integration/${digest(request.runId).slice(0, 16)}`) throw new Error('Conflict repair integration ref does not match run identity');
  const current = await git(request.repoPath, 'rev-parse', '--verify', request.integrationRef);
  await git(request.repoPath, 'merge-base', '--is-ancestor', request.checkpoint.mergeHead, current);
  await assertProvenance(request.repoPath, request.baseCommit, [current], request.approvedCommits);
}

/** Only same-run, delivered text changes can become a bounded repair. */
export async function prepareConflictRepair(request: RepairRequest & {
  evidence: IntegrationConflict; approvedCommits: string[]; allowedPaths?: string[];
}): Promise<ConflictRepair> {
  await request.assertOwnership();
  const tree = await inspectJobWorktree({ ...request, allowPendingMerge: true });
  if (request.integrationRef !== `refs/heads/task-graph/integration/${digest(request.runId).slice(0, 16)}`) throw new Error('Conflict repair integration ref does not match run identity');
  const evidence = request.evidence;
  const mergeHead = await git(tree.path, 'rev-parse', '--verify', 'MERGE_HEAD');
  const current = await git(request.repoPath, 'rev-parse', '--verify', request.integrationRef);
  if (!evidence.mergeHead || tree.head !== evidence.candidateCommit || mergeHead !== evidence.mergeHead) throw new Error('Conflict repair identity changed');
  await git(request.repoPath, 'merge-base', '--is-ancestor', mergeHead, current);
  await git(request.repoPath, 'merge-base', '--is-ancestor', evidence.integrationCommit, current);
  await assertProvenance(request.repoPath, request.baseCommit, [tree.head, current], request.approvedCommits);
  const paths = (await git(tree.path, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean).sort();
  if (!paths.length || JSON.stringify(paths) !== JSON.stringify([...evidence.paths].sort())) throw new Error('Conflict repair paths changed');
  const mergeBase = await git(tree.path, 'merge-base', tree.head, mergeHead);
  const changed = async (head: string) => (await git(tree.path, 'diff', '--no-renames', '--name-only', '-z', mergeBase, head)).split('\0');
  const left = await changed(tree.head), right = await changed(mergeHead);
  const originals: Record<string, string> = Object.create(null), stageHashes: Record<string, string> = Object.create(null);
  for (const name of paths) {
    if (!safePath(name) || !left.includes(name) || !right.includes(name) || request.allowedPaths && !request.allowedPaths.includes(name)) throw new Error(`Conflict repair path exceeds scope: ${name}`);
    const entries = (await stages(tree.path, name)).split('\0').filter(Boolean);
    if (entries.length !== 3 || entries.some((entry, index) => !new RegExp(`^100(644|755) [a-f0-9]+ ${index + 1}\\t`).test(entry))) throw new Error(`Conflict repair requires ordinary text changes, not rename/delete/symlink: ${name}`);
    const renames = await Promise.all([tree.head, mergeHead].map(head => git(tree.path, 'diff', '--name-only', '--diff-filter=R', '-M', '-z', mergeBase, head)));
    if (renames.some(changes => changes.split('\0').includes(name))) throw new Error(`Conflict repair does not support renamed files: ${name}`);
    const binary = await git(tree.path, 'diff', '--numstat', mergeBase, tree.head, '--', `:(literal)${name}`);
    const otherBinary = await git(tree.path, 'diff', '--numstat', mergeBase, mergeHead, '--', `:(literal)${name}`);
    if (binary.startsWith('-\t') || otherBinary.startsWith('-\t')) throw new Error(`Conflict repair does not support binary files: ${name}`);
    const bytes = await fs.readFile(await regularFile(tree.path, name));
    if (bytes.includes(0) || bytes.length > 1024 * 1024) throw new Error(`Conflict repair requires bounded text: ${name}`);
    originals[name] = digest(bytes); stageHashes[name] = digest(await stages(tree.path, name));
  }
  return { candidateCommit: tree.head, integrationCommit: current, mergeHead, paths, ...(await outside(tree.path, paths)), originals, stages: stageHashes };
}

/** A crash after staging or committing resumes the same resolution; unrelated bytes remain untouched. */
export async function finishConflictRepair(request: RepairRequest & { checkpoint: ConflictRepair; resolutionFile: string; approvedCommits: string[] }): Promise<string> {
  await request.assertOwnership();
  await assertConflictIntegrationBaseline(request);
  const saved = request.checkpoint;
  const tree = await inspectJobWorktree({ ...request, resumeCommit: saved.candidateCommit, allowPendingMerge: true });
  if (await fs.realpath(request.resolutionFile) !== request.resolutionFile || !(await fs.lstat(request.resolutionFile)).isFile()) throw new Error('Resolution artifact must be a regular file');
  const bytes = await fs.readFile(request.resolutionFile);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Resolution artifact exceeds limit');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const files: { path: string; content: string }[] = value && typeof value === 'object' && 'files' in value && Array.isArray(value.files) ? value.files : [];
  if (files.length !== saved.paths.length || files.some(file => !file || !safePath(file.path) || typeof file.content !== 'string' || file.content.includes('\0') ||
      Buffer.byteLength(file.content) > 1024 * 1024 || /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(file.content)) ||
      JSON.stringify(files.map(file => file.path).sort()) !== JSON.stringify([...saved.paths].sort())) throw new Error('Resolution paths must exactly match approved conflict paths with resolved text');
  const mergeHead = await git(tree.path, 'rev-parse', '--verify', 'MERGE_HEAD').catch(() => '');
  if (!mergeHead && tree.head !== saved.candidateCommit) {
    const parents = (await git(tree.path, 'rev-list', '--parents', '-1', tree.head)).split(' ').slice(1);
    if (JSON.stringify(parents) !== JSON.stringify([saved.candidateCommit, saved.mergeHead]) || await git(tree.path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Completed repair identity changed');
    if ((await outside(tree.path, saved.paths)).indexOutside !== saved.indexOutside) throw new Error('Completed repair changed outside paths');
    for (const file of files) if (!Buffer.from(file.content).equals(await fs.readFile(await regularFile(tree.path, file.path)))) throw new Error('Completed repair differs from saved resolution');
    await request.assertOwnership(); return tree.head;
  }
  if (tree.head !== saved.candidateCommit || mergeHead !== saved.mergeHead) throw new Error('Pending repair identity changed');
  const actual = await outside(tree.path, saved.paths);
  if (actual.indexOutside !== saved.indexOutside || actual.worktreeOutside !== saved.worktreeOutside) throw new Error('Worktree outside conflict paths changed');
  for (const file of files) {
    const target = await regularFile(tree.path, file.path), currentBytes = await fs.readFile(target);
    const originalMode = (await git(tree.path, 'ls-tree', saved.candidateCommit, '--', `:(literal)${file.path}`)).split(' ')[0];
    const currentMode = (await fs.stat(target)).mode & 0o111 ? '100755' : '100644';
    if (originalMode !== currentMode) throw new Error('Conflict file mode changed outside the saved repair');
    if (digest(currentBytes) !== saved.originals[file.path] && !currentBytes.equals(Buffer.from(file.content))) throw new Error('Conflict file changed outside the saved repair');
    const currentStages = await stages(tree.path, file.path);
    if (digest(currentStages) !== saved.stages[file.path]) {
      const blob = createHash(saved.candidateCommit.length === 64 ? 'sha256' : 'sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex');
      if (!new RegExp(`^100(644|755) ${blob} 0\\t`).test(currentStages) || currentStages.split('\0').filter(Boolean).length !== 1) throw new Error('Conflict index changed outside the saved repair');
    }
  }
  await request.assertOwnership();
  for (const file of files) await fs.writeFile(await regularFile(tree.path, file.path), file.content);
  await git(tree.path, 'add', '--', ...files.map(file => `:(literal)${file.path}`));
  if (await git(tree.path, 'diff', '--name-only', '--diff-filter=U')) throw new Error('Unresolved conflict remains');
  await request.assertOwnership();
  await git(tree.path, '-c', 'commit.gpgsign=false', '-c', 'user.name=Agent Platform', '-c', 'user.email=agent-platform@localhost',
    'commit', '-m', `Task graph conflict repair ${digest(bytes).slice(0, 16)}`);
  return git(tree.path, 'rev-parse', 'HEAD');
}
