import { isDeepStrictEqual } from 'node:util';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { prisma } from '../prisma';
import { executionProgress, type ExecutionProgress } from '../task-graph/execution-progress';
import { preparationHash } from '../task-graph/preparation-contract';
import { getResourceApproval } from './access';

async function isResourcePreparationRetry(id: string, job: TaskGraphExecution, progress: ExecutionProgress, db: Prisma.TransactionClient) {
  if (progress.lastFailure?.code !== 'environment_failed' || progress.lastFailure.requiresUserDecision !== false) return false;
  const key = preparationHash({ executionId: job.id, revision: progress.revision - 1, detail: progress.lastFailure.detail, wakeId: id });
  const deferred = await db.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId, kind: 'execution_conditions_unavailable',
    idempotencyKey: `conditions-unavailable:${key}`, payload: { path: ['wakeId'], equals: id } } });
  if (!deferred) return false;
  const outcome = await db.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: deferred.runId,
    idempotencyKey: `execution:${job.id}:outcome:admission-deferred:${key}` } } });
  const saved = outcome?.payload;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
  const result = saved.outcome;
  return outcome?.nodeId === job.nodeId && outcome.kind === 'execution_outcome' && saved.executionId === job.id &&
    saved.claimToken === job.claimToken && saved.expectedRevision === progress.revision - 1 &&
    !!result && typeof result === 'object' && !Array.isArray(result) && result.kind === 'admission_deferred' &&
    isDeepStrictEqual(executionProgress({ progress: saved.progress }), progress);
}

export async function validateResourceAdmission(id: string, nodeId: string, executionIds: string[], db: Prisma.TransactionClient = prisma) {
  const approval = await getResourceApproval(id, db);
  const { launch, source, application } = approval.payload;
  if (approval.status !== 'approved' || !['waiting', 'scheduled', 'failed'].includes(application.state) || application.runId) throw new Error('资源授权已失效或已经派发');
  const node = await db.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  const expected = launch.graphExecution ? [launch.graphExecution.executionId]
    : launch.graphReview?.nodeId === nodeId ? node.executions.map(job => job.id) : [];
  if (!expected.length || expected.slice().sort().join() !== executionIds.slice().sort().join()) throw new Error('资源审批不属于本次执行集合');
  if (source) {
    const original = await db.taskRun.findUniqueOrThrow({ where: { id: source.taskRunId } });
    if (original.taskId !== launch.taskId || JSON.parse(original.controlMetadata || '{}').resourceRequestId !== id) throw new Error('原执行未提交此资源申请');
    if (!['completed', 'failed', 'interrupted', 'stopped'].includes(original.status)) throw new Error('资源申请的原执行尚未停止');
  }
  for (const job of node.executions.filter(job => expected.includes(job.id))) {
    const progress = executionProgress(job.dispatchMetadata);
    if (!progress) throw new Error('资源接续缺少原执行状态');
    if (launch.graphExecution) {
      const awaitingSourceDecision = source && progress.phase === 'implement' && progress.state === 'waiting_for_user' &&
        progress.taskRunId === source.taskRunId && (!progress.lastFailure || await isResourcePreparationRetry(id, job, progress, db));
      if (job.childTaskId !== launch.taskId || source && job.taskRunId !== source.taskRunId ||
          job.claimToken !== launch.graphExecution.claimToken || progress.lastFailure?.code !== 'permission_required' && !awaitingSourceDecision) throw new Error('资源申请的执行归属或阻塞原因已改变');
    } else {
      if (progress.phase !== launch.graphReview?.phase || source && (progress.review?.kind !== 'running' || progress.review.taskRunId !== source.taskRunId || progress.review.claimKey !== launch.graphReview.claimKey || progress.review.candidateCommit !== job.commit) ||
          progress.lastFailure?.code !== 'blocked_require_human') throw new Error('资源申请的复核阶段已改变');
    }
  }
  return approval;
}

export async function preserveResourceReviewRuntime(tx: Prisma.TransactionClient, approval: Awaited<ReturnType<typeof getResourceApproval>>, nextClaimKey: string) {
  const { launch } = approval.payload;
  if (launch.graphReview?.phase !== 'acceptance') return;
  const { runId, nodeId, claimKey } = launch.graphReview;
  const original = await tx.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: { runId, idempotencyKey: claimKey + ':runtime' } } });
  const receipt = original.payload;
  if (original.nodeId !== nodeId || original.kind !== 'acceptance_runtime_prepared' || !receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.directory !== launch.workingDirectory) throw new Error('原验收工作目录回执已改变');
  await tx.taskGraphEvent.create({ data: { runId, nodeId, kind: 'acceptance_runtime_prepared', idempotencyKey: nextClaimKey + ':runtime',
    payload: { ...receipt, resourceApprovalId: approval.id, originalRuntimeEventId: original.id } } });
}
