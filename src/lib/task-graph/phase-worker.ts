import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { createGraphWriter, observeGraphWriter, observeTaskRunWriter, type WriterObservation, type GraphWriter } from './writer-ownership';
import { executionProgress, initialExecutionProgress, metadataWithProgress, type ExecutionProgress } from './execution-progress';

/** Platform checks and saved review pickup need a live owner independently of the old model TaskRun. */
export async function registerGraphReviewWorker(runId: string, nodeKey: string): Promise<{ nodeId: string; worker: GraphWriter } | null> {
  const worker = await createGraphWriter();
  return prisma.$transaction(async tx => {
    const original = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.id} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: original.id }, include: { executions: true } });
    if (!['claimed', 'verifying'].includes(node.status) || !node.executions.length || node.executions.some(job => job.status !== 'integrated')) return null;
    for (const job of node.executions) {
      const progress: ExecutionProgress = executionProgress(job.dispatchMetadata) || { ...initialExecutionProgress(), phase: 'architecture', workspaceBase: job.baseCommit, candidateCommit: job.commit || undefined };
      if (!job.commit) throw new Error('Phase worker has no integrated candidate');
      if (progress.worker && (progress.worker.supervisor.pid !== worker.supervisor.pid || progress.worker.supervisor.startTime !== worker.supervisor.startTime || progress.worker.supervisor.bootId !== worker.supervisor.bootId)) {
        if ((await observeGraphWriter(progress.worker, Boolean(progress.workerReleasedAt))).kind !== 'exited') throw new Error('Another phase worker still owns this verification');
      }
      await tx.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
        { ...progress, revision: progress.revision + 1, candidateCommit: job.commit, worker, workerReleasedAt: undefined }) } });
    }
    await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, kind: 'phase_worker_started', idempotencyKey: `review-worker:${worker.nonce}`, payload: { worker, executionIds: node.executions.map(job => job.id) } } });
    return { nodeId: node.id, worker };
  });
}

export async function releaseGraphReviewWorker(nodeId: string, nonce: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
    const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId }, include: { node: true } });
    const released: string[] = [];
    for (const job of jobs) {
      const progress = executionProgress(job.dispatchMetadata);
      if (progress?.worker?.nonce !== nonce || progress.workerReleasedAt) continue;
      progress.workerReleasedAt = new Date().toISOString();
      await tx.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, revision: progress.revision + 1 }) } });
      released.push(job.id);
    }
    if (released.length) await tx.taskGraphEvent.create({ data: { runId: jobs[0].node.runId, nodeId, kind: 'phase_worker_released', idempotencyKey: `review-worker-released:${nonce}`, payload: { executionIds: released, nonce } } });
  });
}

export async function releaseGraphExecutionWorker(executionId: string, claimToken: string, nonce: string) {
  await prisma.$transaction(async tx => {
    const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
    const progress = executionProgress(job.dispatchMetadata);
    if (job.claimToken !== claimToken || progress?.worker?.nonce !== nonce || progress.workerReleasedAt) return;
    await tx.taskGraphExecution.update({ where: { id: executionId }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...progress, revision: progress.revision + 1, workerReleasedAt: new Date().toISOString() }) } });
    await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'phase_worker_released',
      idempotencyKey: `execution-worker-released:${nonce}`, payload: { executionId, nonce } } });
  });
}

/** The current platform phase owns work independently of a completed model run. */
export async function observeExecutionWriter(job: { dispatchMetadata: unknown; taskRunId: string | null }): Promise<WriterObservation> {
  const progress = executionProgress(job.dispatchMetadata);
  if (!progress) return { kind: 'unknown', reason: 'Execution has no versioned writer identity' };
  if (progress.worker) {
    const observation = await observeGraphWriter(progress.worker, Boolean(progress.workerReleasedAt));
    if (observation.kind !== 'exited') return observation;
  }
  const taskRunId = job.taskRunId || (progress.worker ? progress.taskRunId : undefined);
  if (taskRunId) return observeTaskRunWriter(taskRunId);
  return progress.worker ? { kind: 'exited' } : { kind: 'unknown', reason: 'Claim has no durable current TaskRun writer' };
}


/** A one-time legacy adoption may carry explicit exit proof before writer metadata existed. */
export async function assertExecutionWriterExited(tx: Prisma.TransactionClient, job: {
  id: string; nodeId: string; taskRunId: string | null; claimToken: string | null;
  dispatchMetadata: unknown; worktreePath: string | null; worktreeBranch: string | null;
}) {
  const observation = await observeExecutionWriter(job);
  if (observation.kind === 'exited') return;
  const progress = executionProgress(job.dispatchMetadata);
  if (observation.kind === 'unknown' && progress && !progress.worker) {
    const event = await tx.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId, kind: 'execution_progress_adopted', idempotencyKey: `execution:${job.id}:progress-adopted` } });
    const proof = event?.payload;
    if (proof && typeof proof === 'object' && !Array.isArray(proof)) {
      const ownership: unknown = Reflect.get(proof, 'ownership');
      const authorization: unknown = Reflect.get(proof, 'authorization');
      if (ownership && typeof ownership === 'object' && Reflect.get(ownership, 'writerExited') === true &&
          Reflect.get(proof, 'executionId') === job.id && Reflect.get(proof, 'taskRunId') === job.taskRunId &&
          Reflect.get(proof, 'revision') === progress.revision && Reflect.get(proof, 'claimToken') === job.claimToken &&
          Reflect.get(proof, 'candidateCommit') === progress.candidateCommit && Reflect.get(proof, 'workspaceBase') === progress.workspaceBase &&
          Reflect.get(ownership, 'path') === job.worktreePath && Reflect.get(ownership, 'branch') === job.worktreeBranch &&
          typeof authorization === 'string' && authorization.trim()) return;
    }
  }
  throw new Error('原执行者仍存活或无法确认退出，不能重复派发');
}
