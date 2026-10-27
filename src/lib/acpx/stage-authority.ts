import { requireGraphNodeActive } from '../task-graph/run-control';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { assertExecutionOwnership, executionProgress, immutableDispatchMetadata } from '../task-graph/execution-progress';
import { assertGraphReviewOwnership } from '../task-graph/review-ownership';
import type { AcpxRunRequest } from './types';
import { W001StageContractError, type StageAuthority } from './stage-execution-request';

/** Observe existing authorities. This creates no reservation and advances no state or budget. */
export async function captureStageAuthority(request: AcpxRunRequest, taskRunId: string): Promise<StageAuthority | null> {
  if (request.graphConversation) throw new W001StageContractError('legacy conversation authority is retired');
  const authorities = [request.graphExecution, request.graphReview].filter(Boolean);
  if (!authorities.length) return null;
  if (authorities.length !== 1) throw new W001StageContractError('ambiguous graph authority');
  if (request.graphExecution) {
    const binding = request.graphExecution;
    const job = await assertExecutionOwnership(binding.executionId, binding.claimToken, binding.revision);
    await requireGraphNodeActive(job.nodeId);
    const progress = executionProgress(job.dispatchMetadata);
    if (!progress || job.taskRunId !== taskRunId || progress.taskRunId !== taskRunId || job.childTaskId !== request.taskId) {
      throw new W001StageContractError('execution TaskRun identity changed');
    }
    return { kind: 'execution', ...binding, taskRunId,
      inputFingerprint: createHash('sha256').update(JSON.stringify({ dispatch: immutableDispatchMetadata(job.dispatchMetadata), conflict: progress.conflictRepair || null })).digest('hex'),
      phase: progress.conflictRepair ? 'conflict_repair' : progress.phase,
      candidateCommit: progress.conflictRepair?.candidateCommit || progress.candidateCommit || job.commit || null,
      sourceRoots: job.worktreePath ? [job.worktreePath] : [] };
  }
  if (request.graphReview) {
    const binding = request.graphReview;
    await requireGraphNodeActive(binding.nodeId);
    await assertGraphReviewOwnership(binding.nodeId, binding.phase, binding.claimKey, taskRunId);
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: binding.nodeId }, include: { executions: { orderBy: { id: 'asc' } } } });
    if (node.runId !== binding.runId) throw new W001StageContractError('review route identity changed');
    return { kind: 'review', ...binding, taskRunId,
      candidates: node.executions.map(job => ({ repository: job.repository, commit: job.commit })),
      sourceRoots: [...(request.extraReadOnlyPaths || [])] };
  }
  throw new W001StageContractError('missing stage authority');
}
