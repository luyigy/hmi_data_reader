import { observeExecutionWriter } from './phase-worker';
import path from 'node:path';
import { graphGit } from './git-command';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { applyExecutionOutcomeTx, executionProgress, assertExecutionOwnership } from './execution-progress';
import { observeTaskRunWriter, observeGraphWriter, type WriterObservation } from './writer-ownership';
import { withRepositoryLock } from './repository-lock';
import { commitJobWorktree, inspectJobWorktree, TaskGraphGitError } from './worktree';
import { parseImplementationResult, type ImplementationResult } from './implementation-result';
import { pendingConversationInputs, recoverConversationInputs, completeConversationTurn } from './conversation-inbox';

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
  const taskRunId = job.taskRunId || executionProgress(job.dispatchMetadata)?.taskRunId;
  const progress = executionProgress(job.dispatchMetadata);
  if (progress?.worker) {
    const worker = await observeGraphWriter(progress.worker, Boolean(progress.workerReleasedAt));
    await recordObservation(job.node.runId, job.nodeId, `phase:${job.id}:${progress.worker.nonce}`, worker);
    if (worker.kind !== 'exited') return false;
  }
  const observation = await observeExecutionWriter(job);
  await recordObservation(job.node.runId, job.nodeId, `${job.id}:${job.claimToken}`, observation);
  if (observation.kind !== 'exited' || !progress) return false;
  const previous = taskRunId ? await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } }) : null;
  if (previous?.status === 'completed') await completeConversationTurn(job.id, previous.id);
  let phase = progress.phase;
  let waitNote: string | undefined;
  let waitResult: 'question' | 'answered' = 'question';
  let blockedResult: Extract<ImplementationResult, { status: 'blocked' }> | undefined;
  let candidate = progress.candidateCommit;
  if (job.worktreePath && job.worktreeBranch && progress.workspaceBase) {
    const recordedPath = job.worktreePath; const recordedBranch = job.worktreeBranch; const workspaceBase = progress.workspaceBase;
    try {
      candidate = await withRepositoryLock(job.repository, async () => {
        await assertExecutionOwnership(job.id, claimToken, progress.revision);
        const inspected = await inspectJobWorktree({ repoPath: job.repository, runId: job.node.runId, jobId: job.id,
          baseCommit: workspaceBase, ...(progress.candidateCommit ? { resumeCommit: progress.candidateCommit } : {}), ...(progress.conflictRepair ? { allowPendingMerge: true } : {}) });
        if (path.resolve(inspected.path) !== path.resolve(recordedPath) || inspected.branch !== recordedBranch) throw new TaskGraphGitError('workspace_collision', 'Restart workspace path or branch differs from the execution ledger', inspected.path);
        await assertExecutionOwnership(job.id, claimToken, progress.revision);
        if (progress.conflictRepair) return progress.candidateCommit;
        return commitJobWorktree({ repoPath: job.repository, runId: job.node.runId, jobId: job.id, message: `Task graph restart checkpoint ${job.node.key}/${job.key}` });
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = error instanceof TaskGraphGitError && error.code === 'integration_conflict' ? 'integration_conflict' : 'ownership_mismatch';
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
        const owned = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
        if (owned.status !== 'claimed' || owned.claimToken !== claimToken || executionProgress(owned.dispatchMetadata)?.revision !== progress.revision) return;
        if (taskRunId) await interruptExitedRun(tx, taskRunId);
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
  if (previous?.status === 'completed' && ['implement', 'collect_result'].includes(phase)) {
    try {
      const result = parseImplementationResult(previous.participants[0]?.summary || previous.summary || '');
      if (result.status === 'delivered') phase = 'check';
      if (result.status === 'waiting_for_user' || result.status === 'answered') { waitNote = result.note; waitResult = result.status === 'answered' ? 'answered' : 'question'; }
      if (result.status === 'blocked') blockedResult = result;
    } catch { phase = 'collect_result'; }
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const currentProgress = executionProgress(current.dispatchMetadata);
    if (current.status !== 'claimed' || current.claimToken !== job.claimToken || current.taskRunId !== job.taskRunId || currentProgress?.revision !== progress.revision) return false;
    if (taskRunId) await interruptExitedRun(tx, taskRunId);
    if (taskRunId && previous?.status !== 'completed') await recoverConversationInputs(tx, job.id, taskRunId);
    const hasInput = (await pendingConversationInputs(tx, job.node.runId, job.id)).length > 0;
    const saved = await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: claimToken, expectedRevision: progress.revision,
      outcomeId: `restart-checkpoint:${job.claimToken}`, outcome: { kind: 'checkpoint', phase: waitNote || hasInput || blockedResult ? 'implement' : phase, ...(candidate ? { candidateCommit: candidate } : {}) } });
    if (blockedResult) {
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken, expectedRevision: saved.revision,
        outcomeId: `restart-blocked:${job.claimToken}`, outcome: { kind: 'decision_required', failure: { code: blockedResult.blockerKind,
          detail: blockedResult.note, blockedPhase: 'implementation', ...(blockedResult.blockerKind === 'environment_failed' ? { owner: 'platform', requiresUserDecision: false } : {}) } } });
      return true;
    }
    if (waitNote || hasInput) {
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken, expectedRevision: saved.revision,
        outcomeId: `restart-conversation:${job.claimToken}`, outcome: { kind: 'waiting_for_user', note: waitNote || '已保存结果，先处理原话题的新消息。', result: waitResult } });
      return true;
    }
    await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: claimToken, expectedRevision: saved.revision,
      outcomeId: `restart-requeue:${job.claimToken}`, outcome: { kind: 'platform_retry', failure: { code: 'writer_exited', detail: 'Confirmed local writer exit; resume the persisted phase without human resume.' } } });
    return true;
  });
}

export async function recoverGraphReview(nodeId: string): Promise<'ready' | 'waiting' | 'none'> {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  for (const job of node.executions) {
    const progress = executionProgress(job.dispatchMetadata);
    const worker = progress?.worker;
    if (!worker) continue;
    const observation = await observeGraphWriter(worker, Boolean(progress.workerReleasedAt));
    await recordObservation(node.runId, node.id, `review-phase:${worker.nonce}`, observation);
    if (observation.kind !== 'exited') return 'waiting';
  }
  const bindings = node.executions.map(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.candidateCommit === job.commit ? binding : undefined; });
  if (bindings.every(binding => binding?.kind === 'ready')) {
    const reserved = bindings[0];
    if (reserved && !await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: reserved.claimKey } } })) return 'ready';
    const owned = node.executions.every(job => executionProgress(job.dispatchMetadata)?.worker);
    if (!owned || !reserved || reserved.kind !== 'ready') return 'ready';
    // A reserved claim with an exited phase owner never reached atomic TaskRun binding.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
      const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
      if (current.status !== 'verifying') return;
      for (const job of current.executions) {
        const progress = executionProgress(job.dispatchMetadata);
        const before = node.executions.find(previous => previous.id === job.id);
        const previous = executionProgress(before?.dispatchMetadata);
        if (!progress || !previous || progress.revision !== previous.revision || progress.worker?.nonce !== previous.worker?.nonce || progress.review?.kind !== 'ready' || progress.review.claimKey !== reserved.claimKey || progress.review.candidateCommit !== job.commit) return;
      }
      const generation = Math.max(...current.executions.map(job => executionProgress(job.dispatchMetadata)?.revision || 0)) + 1;
      for (const job of current.executions) {
        const progress = executionProgress(job.dispatchMetadata);
        if (!progress || !job.claimToken) throw new Error('Reserved review has no versioned ownership');
        await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
          outcomeId: `review-prelaunch:${progress.worker?.nonce}:${reserved.claimKey}`, outcome: { kind: 'review_retry', claimKey: `${reserved.claimKey}:restart:${generation}`,
            failure: { code: 'review_writer_exited', detail: 'Reserved review owner exited before TaskRun binding; retry the same phase automatically.' } } });
      }
    });
    return (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, select: { status: true } })).status === 'verifying' ? 'ready' : 'waiting';
  }
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
