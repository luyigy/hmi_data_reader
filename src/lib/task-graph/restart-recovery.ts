import path from 'node:path';
import { graphGit } from './git-command';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { applyExecutionOutcomeTx, executionProgress, assertExecutionOwnership } from './execution-progress';
import { observeTaskRunWriter, type WriterObservation } from './writer-ownership';
import { withRepositoryLock } from './repository-lock';
import { commitJobWorktree, inspectJobWorktree, TaskGraphGitError } from './worktree';
import { parseImplementationResult } from './implementation-result';

async function recordObservation(runId: string, nodeId: string, identity: string, observation: WriterObservation) {
  const idempotencyKey = `writer-observation:${identity}:${observation.kind}`;
  await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey } }, update: {},
    create: { runId, nodeId, idempotencyKey, kind: 'writer_observation', payload: observation } });
}

async function interruptExitedRun(tx: Prisma.TransactionClient, taskRunId: string) {
  await tx.taskRun.updateMany({ where: { id: taskRunId, status: { in: ['pending', 'running', 'waiting_for_input'] } },
    data: { status: 'interrupted', completedAt: new Date(), summary: 'Previous local writer exited; task graph resumes from preserved progress.' } });
  await tx.taskRunParticipant.updateMany({ where: { taskRunId, status: { in: ['pending', 'running', 'waiting_for_input'] } }, data: { status: 'interrupted' } });
}

export async function recoverGraphExecution(executionId: string) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
  if (job.status !== 'claimed' || !job.claimToken) return false;
  const claimToken = job.claimToken;
  const taskRunId = job.taskRunId;
  const progress = executionProgress(job.dispatchMetadata);
  const observation: WriterObservation = taskRunId && progress ? await observeTaskRunWriter(taskRunId) : { kind: 'unknown', reason: 'Claim has no durable current TaskRun writer' };
  await recordObservation(job.node.runId, job.nodeId, `${job.id}:${job.claimToken}`, observation);
  if (observation.kind !== 'exited' || !progress || !taskRunId) return false;
  const previous = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  let phase = progress.phase;
  let candidate = progress.candidateCommit;
  if (job.worktreePath && job.worktreeBranch && progress.workspaceBase) {
    const recordedPath = job.worktreePath; const recordedBranch = job.worktreeBranch; const workspaceBase = progress.workspaceBase;
    try {
      candidate = await withRepositoryLock(job.repository, async () => {
        await assertExecutionOwnership(job.id, claimToken, progress.revision);
        const inspected = await inspectJobWorktree({ repoPath: job.repository, runId: job.node.runId, jobId: job.id,
          baseCommit: workspaceBase, ...(progress.candidateCommit ? { resumeCommit: progress.candidateCommit } : {}) });
        if (path.resolve(inspected.path) !== path.resolve(recordedPath) || inspected.branch !== recordedBranch) throw new TaskGraphGitError('workspace_collision', 'Restart workspace path or branch differs from the execution ledger', inspected.path);
        await assertExecutionOwnership(job.id, claimToken, progress.revision);
        return commitJobWorktree({ repoPath: job.repository, runId: job.node.runId, jobId: job.id, message: `Task graph restart checkpoint ${job.node.key}/${job.key}` });
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = error instanceof TaskGraphGitError && error.code === 'integration_conflict' ? 'integration_conflict' : 'ownership_mismatch';
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
        const owned = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        if (owned.status !== 'claimed' || owned.claimToken !== claimToken || executionProgress(owned.dispatchMetadata)?.revision !== progress.revision) return;
        await interruptExitedRun(tx, taskRunId);
        const metadata = job.dispatchMetadata && typeof job.dispatchMetadata === 'object' ? job.dispatchMetadata : {};
        const ref: unknown = Reflect.get(metadata, 'integrationRef');
        const mergeHead = code === 'integration_conflict' ? await graphGit(recordedPath, 'rev-parse', '--verify', 'MERGE_HEAD').catch(() => null) : null;
        const head = code === 'integration_conflict' ? await graphGit(recordedPath, 'rev-parse', 'HEAD').catch(() => null) : null;
        const integrationCommit = typeof ref === 'string' && ref.startsWith('refs/heads/') ? await graphGit(job.repository, 'rev-parse', '--verify', `${ref}^{commit}`).catch(() => null) : mergeHead;
        const paths = code === 'integration_conflict' ? (await graphGit(recordedPath, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean).sort() : [];
        await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'restart_workspace_failed',
          idempotencyKey: `restart-workspace-evidence:${claimToken}`, payload: { executionId: job.id, code, detail, ...(head && integrationCommit ? { integration: { kind: 'conflict', candidateCommit: head, integrationCommit, mergeHead, paths } } : {}) } } });
        await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken, expectedRevision: progress.revision,
          outcomeId: `restart-workspace:${claimToken}`, outcome: { kind: 'decision_required', failure: { code, detail } } });
      });
      return false;
    }
  }
  if (previous.status === 'completed' && ['implement', 'collect_result'].includes(phase)) {
    try { if (parseImplementationResult(previous.participants[0]?.summary || previous.summary || '').status === 'delivered') phase = 'check'; } catch { phase = 'collect_result'; }
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const currentProgress = executionProgress(current.dispatchMetadata);
    if (current.status !== 'claimed' || current.claimToken !== job.claimToken || current.taskRunId !== job.taskRunId || currentProgress?.revision !== progress.revision) return false;
    await interruptExitedRun(tx, taskRunId);
    const saved = await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: claimToken, expectedRevision: progress.revision,
      outcomeId: `restart-checkpoint:${job.claimToken}`, outcome: { kind: 'checkpoint', phase, ...(candidate ? { candidateCommit: candidate } : {}) } });
    await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: claimToken, expectedRevision: saved.revision,
      outcomeId: `restart-requeue:${job.claimToken}`, outcome: { kind: 'platform_retry', failure: { code: 'writer_exited', detail: 'Confirmed local writer exit; resume the persisted phase without human resume.' } } });
    return true;
  });
}

export async function recoverGraphReview(nodeId: string): Promise<'ready' | 'waiting' | 'none'> {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  const bindings = node.executions.map(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.candidateCommit === job.commit ? binding : undefined; });
  if (bindings.every(binding => binding?.kind === 'ready')) return 'ready';
  const running = bindings.filter(binding => binding?.kind === 'running');
  if (!running.length) {
    if (node.executions.every(job => executionProgress(job.dispatchMetadata))) return 'none';
    const legacy = await prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: { in: ['architecture_claimed', 'review_claimed'] } } });
    if (legacy) { await recordObservation(node.runId, node.id, `review:${node.id}:legacy`, { kind: 'unknown', reason: 'Legacy review has no durable current writer identity' }); return 'waiting'; }
    return 'none';
  }
  if (running.length !== node.executions.length) return 'none';
  const binding = running[0];
  if (!binding || binding.kind !== 'running' || running.length !== node.executions.length || running.some(item => item?.kind !== 'running' || item.taskRunId !== binding.taskRunId || item.claimKey !== binding.claimKey)) return 'waiting';
  const observation = await observeTaskRunWriter(binding.taskRunId);
  await recordObservation(node.runId, node.id, `review:${binding.taskRunId}`, observation);
  if (observation.kind !== 'exited') return 'waiting';
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: binding.taskRunId } });
  if (run.status === 'completed') return 'ready';
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
    if (current.status !== 'verifying') return;
    if (current.executions.some(job => { const review = executionProgress(job.dispatchMetadata)?.review; return review?.kind !== 'running' || review.taskRunId !== binding.taskRunId; })) return;
    await interruptExitedRun(tx, binding.taskRunId);
    const generation = Math.max(...current.executions.map(job => executionProgress(job.dispatchMetadata)?.revision || 0)) + 1;
    for (const job of current.executions) {
      const progress = executionProgress(job.dispatchMetadata);
      if (!progress || !job.claimToken) throw new Error('Review restart has no versioned ownership');
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
        outcomeId: `review-restart:${binding.taskRunId}`, outcome: { kind: 'review_retry', claimKey: `${binding.claimKey}:restart:${generation}`,
          failure: { code: 'review_writer_exited', detail: 'Confirmed review writer exit; retry current independent review with preserved code.' } } });
    }
  });
  return (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, select: { status: true } })).status === 'verifying' ? 'ready' : 'waiting';
}
