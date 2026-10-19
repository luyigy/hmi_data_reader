import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { applyExecutionOutcomeTx, executionProgress } from './execution-progress';
import { parsePreparationReceipt, preparationHash, validatePreparationArtifacts } from './preparation-contract';
import { observeExecutionWriter } from './phase-worker';
import { observeTaskRunWriter } from './writer-ownership';
import type { Prisma } from '@prisma/client';
import { executionRetryLimits } from './retry-limits';

async function binding(tx: Prisma.TransactionClient, runId: string, nodeKey: string) {
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true, run: true } });
  const job = node.executions[0], progress = job && executionProgress(job.dispatchMetadata);
  if (!['attention', 'running'].includes(node.run.status) || node.status !== 'attention' || node.executions.length !== 1 || !job.claimToken || !job.commit ||
      job.status !== 'attention' || progress?.state !== 'exhausted' || progress.phase !== 'acceptance' || progress.candidateCommit !== job.commit ||
      progress.platformAttempts < executionRetryLimits.platformAttempts || progress.lastFailure?.code !== 'review_platform_failure' || progress.lastFailure.requiresUserDecision === true || progress.lastFailure.owner && progress.lastFailure.owner !== 'platform') throw new Error('Prepared review requires an exhausted platform acceptance with unchanged integrated candidate');
  const dependencies = await tx.taskGraphNode.findMany({ where: { runId, key: { in: node.dependsOn } }, include: { executions: true }, orderBy: { key: 'asc' } });
  if (dependencies.length !== node.dependsOn.length || dependencies.some(item => !['passed', 'delivered_unverified'].includes(item.status))) throw new Error('Review dependencies have not passed');
  return { node, job, progress, hash: preparationHash({ snapshotHash: node.run.snapshotHash, job, dependencies }) };
}

export async function inspectPreparedReviewBinding(runId: string, nodeKey: string) {
  return prisma.$transaction(async tx => (await binding(tx, runId, nodeKey)).hash);
}

/** Local operator attests a new verified measure, granting one review attempt without replenishing any budget. */
export async function registerPreparedReviewRecovery(input: unknown, remediationCommit: string) {
  const receipt = parsePreparationReceipt(input);
  if (receipt.remediation !== 'missing_capability' || !/^[a-f0-9]{40,64}$/.test(remediationCommit) || await graphGit(process.cwd(), 'rev-parse', 'HEAD') !== remediationCommit) throw new Error('Reviewed remediation code does not match the loaded checkout');
  return prisma.$transaction(async tx => {
    const target = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: receipt.runId, key: receipt.nodeKey } } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${target.id} FOR UPDATE`;
    const key = `prepared-review:${receipt.requestId}`;
    const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: key } } });
    const requestHash = preparationHash({ receipt, remediationCommit });
    if (previous) {
      if (!previous.payload || typeof previous.payload !== 'object' || !('requestHash' in previous.payload) || previous.payload.requestHash !== requestHash) throw new Error('Prepared review requestId reused with different evidence');
      return { kind: 'already_registered', eventId: previous.id };
    }
    const { node, job, progress, hash } = await binding(tx, receipt.runId, receipt.nodeKey);
    if (hash !== receipt.bindingHash) throw new Error('Prepared review binding changed');
    const used = await tx.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'platform_review_preparation', payload: { path: ['remediationIdentity'], equals: `${job.commit}:${remediationCommit}` } } });
    if (used) throw new Error('This code measure already authorized a review of this candidate');
    const oldRuntime = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: `runtime-snapshot:${job.id}:${job.claimToken}` } } });
    const oldPayload = oldRuntime?.payload;
    const snapshot = oldPayload && typeof oldPayload === 'object' && 'snapshot' in oldPayload ? oldPayload.snapshot : null;
    const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && 'source' in snapshot ? snapshot.source : null;
    if (!source || typeof source !== 'object' || Array.isArray(source) || !('origin' in source) || source.origin !== 'host_registration' || !('commit' in source) || source.commit === remediationCommit) throw new Error('Recovery requires a different verified platform code measure');
    const implementation = job.taskRunId ? await tx.taskRun.findUnique({ where: { id: job.taskRunId } }) : null;
    if (!implementation || !['completed', 'failed', 'cancelled'].includes(implementation.status) || (await observeExecutionWriter(job)).kind !== 'exited') throw new Error('Original implementation writer has not exited');
    const reviews = await tx.taskRun.findMany({ where: { taskId: { in: [`task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] } } });
    for (const review of reviews) if (!['completed', 'failed', 'cancelled'].includes(review.status) || (await observeTaskRunWriter(review.id)).kind !== 'exited') throw new Error('A previous reviewer has not demonstrably exited');
    await validatePreparationArtifacts(receipt.artifacts);
    if (await graphGit(process.cwd(), 'rev-parse', 'HEAD') !== remediationCommit) throw new Error('Remediation code changed before publication');
    const event = await tx.taskGraphEvent.create({ data: { runId: receipt.runId, nodeId: node.id, kind: 'platform_review_preparation', idempotencyKey: key,
      payload: { requestHash, receipt, remediationCommit, remediationIdentity: `${job.commit}:${remediationCommit}`, executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision, candidateCommit: job.commit } } });
    await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken!, expectedRevision: progress.revision,
      outcomeId: key, outcome: { kind: 'review_platform_prepared', preparationEventId: event.id } });
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
    await tx.taskGraphRun.update({ where: { id: receipt.runId }, data: { status: 'running' } });
    return { kind: 'registered', eventId: event.id };
  });
}
