import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configuredWorkspaceRoot, projectWorkspaceDirectory } from './workspace-layout';
import { listWorktrees } from './git-worktree';
import { graphGit as git } from './task-graph/git-command';
import { withRepositoryLock } from './task-graph/repository-lock';

export type WorkspaceSafety =
  | { kind: 'retain'; reasons: string[] }
  | { kind: 'released'; savedRef: string };
export type ReferenceCheck = (directory: string) => Promise<WorkspaceSafety>;
const unknownReferences: ReferenceCheck = async () => ({ kind: 'retain', reasons: ['Writer, Session, process and ledger references have not been proven released'] });

/** Read-only inventory. Missing paths, locks, dirty/ignored content and uncertain references always stay visible. */
export async function inspectWorkspace(repository: string, directory: string, checkReferences: ReferenceCheck = unknownReferences) {
  const tree = (await listWorktrees(repository)).find(tree => tree.path === directory);
  const reasons: string[] = [];
  const reference = await checkReferences(directory);
  if (reference.kind === 'retain') reasons.push(...(reference.reasons.length ? reference.reasons : ['References are not released']));
  if (!tree) return { path: directory, branch: null, head: null, reasons: [...reasons, 'Not registered with this repository'], fingerprint: null };
  try {
    if (await fs.realpath(directory) !== directory) reasons.push('Path contains a symbolic link');
    const registry = await git(repository, 'worktree', 'list', '--porcelain');
    const block = registry.split('\n\n').find(block => block.split('\n').includes(`worktree ${directory}`));
    if (block?.split('\n').some(line => /^(locked|prunable)( |$)/.test(line))) reasons.push('Git registration is locked or prunable');
    const common = await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const gitDir = await git(directory, 'rev-parse', '--absolute-git-dir');
    if (common !== await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) reasons.push('Repository identity differs');
    if (gitDir === common) reasons.push('Primary repository cannot be moved or removed');
    const dirty = await git(directory, 'status', '--porcelain', '--untracked-files=all');
    const ignored = await git(directory, 'ls-files', '--others', '--ignored', '--exclude-standard');
    if (dirty) reasons.push('Uncommitted, untracked or conflicted content');
    if (ignored) reasons.push('Ignored content requires preservation');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      if (await fs.lstat(path.join(gitDir, marker)).then(() => true, () => false)) reasons.push(`Pending Git operation: ${marker}`);
    }
    const head = await git(directory, 'rev-parse', 'HEAD');
    if (head !== tree.head) reasons.push('HEAD changed during inspection');
    if (reference.kind === 'released') {
      if (!reference.savedRef.startsWith('refs/') || reference.savedRef === `refs/heads/${tree.branch}`) reasons.push('Independent saved commit reference required');
      else {
        try { await git(repository, 'merge-base', '--is-ancestor', head, reference.savedRef); }
        catch { reasons.push('HEAD contains commits not saved to the approved reference'); }
      }
    }
    return { ...tree, reasons, fingerprint: createHash('sha256').update(JSON.stringify({ head, branch: tree.branch, dirty, ignored, gitDir })).digest('hex') };
  } catch (error) {
    return { ...tree, reasons: [...reasons, `Inspection incomplete: ${error instanceof Error ? error.message : String(error)}`], fingerprint: null };
  }
}

export async function inventoryWorkspaces(repository: string, checkReferences?: ReferenceCheck) {
  return Promise.all((await listWorktrees(repository)).map(tree => inspectWorkspace(repository, tree.path, checkReferences)));
}

type WorkspaceOperation = { kind: 'remove' } | { kind: 'move'; destination: string };
/** Host-owned caller must authorize this exact operation and prove references/Writer exited at execution time. */
export async function operateWorkspace(args: {
  repository: string; directory: string; operation: WorkspaceOperation; expectedFingerprint: string;
  checkReferences: ReferenceCheck; authorize: () => Promise<void>;
}) {
  return withRepositoryLock(args.repository, async () => {
    await args.authorize();
    const registered = await listWorktrees(args.repository);
    if (!registered.some(tree => tree.path === args.directory) && !await fs.lstat(args.directory).then(() => true, () => false)) {
      if (args.operation.kind === 'remove') return { kind: 'already_absent', path: args.directory };
      const reconciled = await inspectWorkspace(args.repository, args.operation.destination, args.checkReferences);
      if (reconciled.fingerprint === args.expectedFingerprint && !reconciled.reasons.length) return { kind: 'moved', from: args.directory, ...reconciled };
      throw new Error('Move state is uncertain; retain both paths');
    }
    const before = await inspectWorkspace(args.repository, args.directory, args.checkReferences);
    if (before.reasons.length || !before.fingerprint || before.fingerprint !== args.expectedFingerprint) throw new Error(`Workspace retained: ${before.reasons.join('; ') || 'snapshot changed'}`);
    if (args.operation.kind === 'move') {
      const destination = args.operation.destination;
      if (!path.isAbsolute(destination) || path.normalize(destination) !== destination || /[\x00-\x1f]/.test(destination)) throw new Error('Invalid move destination');
      const projectRoot = path.join(await fs.realpath(configuredWorkspaceRoot()), await projectWorkspaceDirectory(args.repository));
      if (!destination.startsWith(projectRoot + path.sep)) throw new Error('Destination must belong to the central project directory');
      if (await fs.lstat(destination).then(() => true, () => false)) throw new Error('Move destination already exists');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (await fs.realpath(path.dirname(destination)) !== path.dirname(destination)) throw new Error('Move destination contains symbolic links');
    }
    // Re-read after preparing the destination and authorization. The caller keeps Writer claims excluded for this operation.
    const current = await inspectWorkspace(args.repository, args.directory, args.checkReferences);
    if (current.reasons.length || current.fingerprint !== before.fingerprint) throw new Error('Workspace changed before operation');
    if (args.operation.kind === 'remove') {
      await git(args.repository, 'worktree', 'remove', args.directory);
      return { kind: 'removed', path: args.directory, head: before.head, branch: before.branch };
    }
    await git(args.repository, 'worktree', 'move', args.directory, args.operation.destination);
    const after = await inspectWorkspace(args.repository, args.operation.destination, args.checkReferences);
    if (after.head !== before.head || after.branch !== before.branch || after.reasons.length) throw new Error('Moved workspace requires reconciliation; do not retry deletion');
    return { kind: 'moved', from: args.directory, ...after };
  });
}
