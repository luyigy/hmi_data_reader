import { prisma } from '../prisma';
import { randomUUID } from 'node:crypto';
import { graphGit } from './git-command';
import { executionProgress, initialExecutionProgress, metadataWithProgress } from './execution-progress';
import { withRepositoryLock } from './repository-lock';
import { commitJobWorktree, inspectJobWorktree } from './worktree';

/** Explicit once-only migration; the caller must supply actual process-exit proof, never a timeout guess. */
export async function adoptLegacyExecutionProgress(args: {
  executionId: string; workspaceBase: string; previousCandidateCommit: string; authorization: string;
  assertWriterExited: () => Promise<void>;
}) {
  if (!args.authorization.trim()) throw new Error('Legacy adoption requires an authorization record');
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId }, include: { node: true } });
  return withRepositoryLock(job.repository, () => prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const existing = executionProgress(current.dispatchMetadata);
    if (existing) return existing;
    if (!['ready', 'attention'].includes(current.status) || !current.worktreePath || !current.worktreeBranch) throw new Error('Legacy execution is not paused in a known workspace');
    if (await tx.taskRun.count({ where: { OR: [ ...(current.taskRunId ? [{ id: current.taskRunId }] : []),
      ...(current.childTaskId ? [{ taskId: current.childTaskId }] : []) ], status: { in: ['pending', 'running', 'waiting_for_input'] } } })) throw new Error('Legacy TaskRun is still active');
    await args.assertWriterExited();
    await graphGit(current.repository, 'merge-base', '--is-ancestor', current.baseCommit, args.workspaceBase);
    const checked = await inspectJobWorktree({ repoPath: current.repository, runId: job.node.runId, jobId: job.id,
      baseCommit: args.workspaceBase, resumeCommit: args.previousCandidateCommit });
    if (checked.path !== current.worktreePath || checked.branch !== current.worktreeBranch) throw new Error('Recorded legacy workspace identity mismatch');
    const candidateCommit = await commitJobWorktree({ repoPath: current.repository, runId: job.node.runId, jobId: job.id,
      message: `Adopt current task graph candidate ${job.node.key}/${job.key}` });
    const progress = { ...initialExecutionProgress(), phase: 'implement' as const,
      state: current.status === 'ready' ? 'ready' as const : 'waiting_decision' as const,
      candidateCommit, workspaceBase: args.workspaceBase, ...(current.taskRunId ? { taskRunId: current.taskRunId } : {}),
    };
    const claimToken = current.claimToken || (current.status === 'attention' ? `adoption:${randomUUID()}` : null);
    await tx.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken, dispatchMetadata: metadataWithProgress(current.dispatchMetadata, progress) } });
    await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId,
      kind: 'execution_progress_adopted', idempotencyKey: `execution:${job.id}:progress-adopted`,
      payload: { executionId: job.id, previousCandidateCommit: args.previousCandidateCommit,
        observedHead: checked.head, candidateCommit, workspaceBase: args.workspaceBase,
        authorization: args.authorization, claimToken, taskRunId: current.taskRunId, revision: progress.revision,
        ownership: { path: checked.path, branch: checked.branch, writerExited: true } },
    } });
    return progress;
  }, { timeout: 30000 }));
}
