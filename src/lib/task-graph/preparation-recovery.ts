import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scheduleVerificationRecovery } from './review-recovery';
import { resolveReviewWorkspaces } from './review-workspaces';
import { prepareAcceptanceRuntime } from './acceptance-runtime';
import { requireGraphRunActiveTx } from './run-control';
import { isCompletedNodeStatus, type GraphDefinition } from './domain';
import { prepareGraphSpecInput } from './spec-input';
import { prepareUpstreamInputs } from './upstream-inputs';
import { prepareGraphOutputForTask } from './output-task-context';
import { inspectSavedTaskRuntime } from './runtime-continuity';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { applyExecutionOutcomeTx, executionProgress, metadataWithProgress } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import type { Prisma } from '@prisma/client';
import { executionRetryLimits } from './retry-limits';
import { platformRepository } from '../platform-repository';
import { PreparationRejected, parsePreparationReceipt, preparationBindingTx, preparationHash, validatePreparationArtifacts, type PreparationReceipt } from './preparation-contract';
import { scheduleImplementationRecovery } from './implementation-result';
import { redactSensitiveText } from '../redact-sensitive';

async function preparationRequestTx(tx: Prisma.TransactionClient, receipt: PreparationReceipt, key: string) {
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: receipt.runId, key: receipt.nodeKey } }, select: { id: true } });
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
  const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: key } } });
  return { node, previous };
}

export async function inspectPreparationBinding(runId: string, nodeKey: string, remediation: PreparationReceipt['remediation']) {
  return prisma.$transaction(tx => preparationBindingTx(tx, runId, nodeKey, remediation));
}

/** Local operator authority is the same OS/database capability required by task-graph:doctor. */
export async function registerPlatformPreparation(input: unknown) {
  const receipt = parsePreparationReceipt(input);
  await validatePreparationArtifacts(receipt.artifacts);
  return prisma.$transaction(async tx => {
    const key = `preparation:${receipt.requestId}`;
    const { node, previous } = await preparationRequestTx(tx, receipt, key);
    if (previous) {
      if (preparationHash(previous.payload) !== preparationHash(receipt)) throw new Error('Preparation requestId reused with different payload');
      return { kind: 'already_registered', eventId: previous.id };
    }
    if (await preparationBindingTx(tx, receipt.runId, receipt.nodeKey, receipt.remediation) !== receipt.bindingHash) throw new Error('Stale preparation binding');
    const event = await tx.taskGraphEvent.create({ data: { runId: receipt.runId, nodeId: node.id,
      kind: 'platform_preparation_registered', idempotencyKey: key, payload: receipt } });
    return { kind: 'registered', eventId: event.id };
  });
}

export async function recoverPreparedImplementations(runId: string) {
  const events = await prisma.taskGraphEvent.findMany({ where: { runId, kind: 'platform_preparation_registered' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const event of events) {
    const key = `preparation-consumed:${event.id}`;
    if (await prisma.taskGraphEvent.count({ where: { runId, idempotencyKey: key } })) continue;
    let result: { kind: string; eventId?: string; reason?: string };
    try {
      const receipt = parsePreparationReceipt(event.payload);
      result = await scheduleImplementationRecovery(runId, receipt.nodeKey, `prepared:${event.id}`, event.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const controlledRejection = error instanceof PreparationRejected ||
        /^(实施仍在执行|原任务进程仍在执行|原执行者仍存活|待完成合并尚无|自动处理预算已耗尽|执行归属尚未核对|当前执行不是|缺少当前候选|没有可恢复|缺少原执行归属)/.test(reason) ||
        error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR'].includes(String(error.code));
      if (!controlledRejection) {
        console.error('[TaskGraph] preparation receipt deferred:', { runId, preparationEventId: event.id, reason: redactSensitiveText(reason) });
        continue;
      }
      result = { kind: 'rejected', reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
    }
    await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } },
      create: { runId, nodeId: event.nodeId, kind: 'platform_preparation_consumed', idempotencyKey: key,
        payload: { preparationEventId: event.id, ...result } }, update: {} });
  }
}

async function preparedReviewBinding(tx: Prisma.TransactionClient, runId: string, nodeKey: string) {
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
  return prisma.$transaction(async tx => (await preparedReviewBinding(tx, runId, nodeKey)).hash);
}

/** Local operator attests a new verified measure, granting one review attempt without replenishing any budget. */
export async function registerPreparedReviewRecovery(input: unknown, remediationCommit: string, platformDirectory = platformRepository()) {
  const receipt = parsePreparationReceipt(input);
  if (receipt.remediation !== 'missing_capability' || !/^[a-f0-9]{40,64}$/.test(remediationCommit) || await graphGit(platformDirectory, 'rev-parse', 'HEAD') !== remediationCommit) throw new Error('Reviewed remediation code does not match the loaded checkout');
  await validatePreparationArtifacts(receipt.artifacts);
  const before = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: receipt.runId, key: receipt.nodeKey } }, include: { executions: true } });
  const reviews = await prisma.taskRun.findMany({ where: { taskId: { in: [`task-graph-review-${before.id}`, `task-graph-architecture-${before.id}`] } } });
  if (reviews.some(review => !['completed', 'failed', 'cancelled'].includes(review.status))) throw new Error('A previous reviewer has not demonstrably exited');
  const proof = await observeWriterSnapshot({ jobs: before.executions, taskRunIds: reviews.map(review => review.id), scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) throw new Error('Original implementation or reviewer writer has not exited');
  if (await graphGit(platformDirectory, 'rev-parse', 'HEAD') !== remediationCommit) throw new Error('Remediation code changed before publication');
  return prisma.$transaction(async tx => {
    const key = `prepared-review:${receipt.requestId}`;
    const { previous } = await preparationRequestTx(tx, receipt, key);
    const requestHash = preparationHash({ receipt, remediationCommit });
    if (previous) {
      if (!previous.payload || typeof previous.payload !== 'object' || !('requestHash' in previous.payload) || previous.payload.requestHash !== requestHash) throw new Error('Prepared review requestId reused with different evidence');
      return { kind: 'already_registered', eventId: previous.id };
    }
    const { node, job, progress, hash } = await preparedReviewBinding(tx, receipt.runId, receipt.nodeKey);
    if (hash !== receipt.bindingHash) throw new Error('Prepared review binding changed');
    const used = await tx.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'platform_review_preparation', payload: { path: ['remediationIdentity'], equals: `${job.commit}:${remediationCommit}` } } });
    if (used) throw new Error('This code measure already authorized a review of this candidate');
    const oldRuntime = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: `runtime-snapshot:${job.id}:${job.claimToken}` } } });
    const oldPayload = oldRuntime?.payload;
    const snapshot = oldPayload && typeof oldPayload === 'object' && 'snapshot' in oldPayload ? oldPayload.snapshot : null;
    // Runtime source identifies project resources, not the platform revision. A project pin may legitimately have no declaration.
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !('version' in snapshot) || snapshot.version !== 1 ||
        !('executionId' in snapshot) || snapshot.executionId !== job.id || !('claimToken' in snapshot) || snapshot.claimToken !== job.claimToken ||
        !('identity' in snapshot) || typeof snapshot.identity !== 'string') throw new Error('Recovery requires the original claim-bound runtime pin');
    const implementation = job.taskRunId ? await tx.taskRun.findUnique({ where: { id: job.taskRunId } }) : null;
    if (!implementation || !['completed', 'failed', 'cancelled'].includes(implementation.status) || !await writerSnapshotMatches(tx, proof)) throw new Error('Original implementation writer has not exited');
    const currentReviews = await tx.taskRun.findMany({ where: { taskId: { in: [`task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] } } });
    if (currentReviews.length !== reviews.length || currentReviews.some(review => !reviews.some(old => old.id === review.id))) throw new Error('Reviewer membership changed during observation');
    const event = await tx.taskGraphEvent.create({ data: { runId: receipt.runId, nodeId: node.id, kind: 'platform_review_preparation', idempotencyKey: key,
      payload: { requestHash, receipt, remediationCommit, remediationIdentity: `${job.commit}:${remediationCommit}`, executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision, candidateCommit: job.commit } } });
    await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken!, expectedRevision: progress.revision,
      outcomeId: key, outcome: { kind: 'review_platform_prepared', preparationEventId: event.id } });
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'verifying' } });
    await tx.taskGraphRun.updateMany({ where: { id: receipt.runId, status: { not: 'paused' } }, data: { status: 'running' } });
    return { kind: 'registered', eventId: event.id };
  });
}

async function executionConditionsVersion() {
  // Operational facts bound retries; they never grant resources or replace a source pin.
  return { build: await readFile(path.join(platformRepository(), '.next/BUILD_ID'), 'utf8').then(value => value.trim(), () => 'development'),
    upstreamMaxBytes: process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES || '268435456' };
}

/** Existing Coordinator calls this only in spare execution capacity, never in a DB transaction. */
export async function reconcileExecutionConditions(executionId: string) {
  const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: { include: { run: true } } } });
  const progress = executionProgress(before.dispatchMetadata);
  if (progress && ['architecture', 'acceptance'].includes(progress.phase)) return reconcileReviewConditions(before.nodeId);
  if (before.status !== 'attention' || !progress || !['waiting_decision', 'waiting_for_user', 'exhausted'].includes(progress.state) ||
      progress.lastFailure?.owner !== 'platform' || progress.lastFailure.requiresUserDecision === true ||
      !['prepare', 'implement', 'collect_result', 'check', 'integrate'].includes(progress.phase) || progress.conflictRepair ||
      !before.childTaskId || !before.worktreePath || !progress.candidateCommit || !progress.workspaceBase ||
      !['running', 'attention'].includes(before.node.run.status)) return false;
  const { node: _node, ...job } = before;
  const proof = await observeWriterSnapshot({ jobs: [job], scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) return false;
  try {
    if (await graphGit(before.worktreePath, 'rev-parse', 'HEAD') !== progress.candidateCommit) return false;
    if (await graphGit(before.worktreePath, 'rev-parse', '--verify', 'MERGE_HEAD').then(() => true, () => false)) return false;
    const inputs = await prepareUpstreamInputs(before.id);
    const spec = await prepareGraphSpecInput(before.node.run.snapshot as unknown as GraphDefinition);
    const output = await prepareGraphOutputForTask(before.childTaskId, `conditions:${before.id}:${progress.revision}`, [before.worktreePath]);
    const runtime = await inspectSavedTaskRuntime({ taskId: before.childTaskId, workspace: before.worktreePath,
      approvedReadOnlyRoots: [...inputs.readOnlyPaths, ...spec.paths, ...output.readOnlyPaths], outputDirectory: output.directory, priorArtifacts: output.priorArtifacts });
    const identity = preparationHash({ executionId, candidate: progress.candidateCommit, scope: before.node.run.snapshotHash,
      inputs: inputs.manifest.hash, runtime: runtime.identity, failure: progress.lastFailure?.code, conditions: await executionConditionsVersion() });
    const key = `conditions-ready:${before.id}:${identity}`;
    return prisma.$transaction(async tx => {
      await requireGraphRunActiveTx(tx, before.node.runId);
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${before.nodeId} FOR UPDATE`;
      if (!await writerSnapshotMatches(tx, proof) || await tx.taskGraphEvent.count({ where: { runId: before.node.runId, idempotencyKey: key } })) return false;
      const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: before.nodeId }, include: { run: true, executions: true } });
      if (current.status !== 'attention' || current.run.snapshotHash !== before.node.run.snapshotHash || current.executions.some(job => job.status === 'claimed')) return false;
      const dependencies = await tx.taskGraphNode.findMany({ where: { runId: current.runId, key: { in: current.dependsOn } } });
      if (dependencies.length !== current.dependsOn.length || !dependencies.every(node => isCompletedNodeStatus(node.status))) return false;
      await tx.taskGraphExecution.update({ where: { id: before.id }, data: { status: 'ready', claimToken: null, claimedAt: null,
        taskRunId: null, sessionId: null, issueKind: null, dispatchMetadata: metadataWithProgress(before.dispatchMetadata,
          { ...progress, revision: progress.revision + 1, state: 'ready', worker: undefined, workerReleasedAt: undefined }) } });
      await tx.taskGraphEvent.create({ data: { runId: current.runId, nodeId: current.id, kind: 'execution_conditions_ready',
        idempotencyKey: key, payload: { executionId: before.id, revision: progress.revision,
          candidateCommit: progress.candidateCommit, claimToken: before.claimToken, inputHash: inputs.manifest.hash, runtimeIdentity: runtime.identity, writerExited: true } } });
      await tx.taskGraphNode.update({ where: { id: current.id }, data: { status: 'claimed' } });
      await tx.taskGraphRun.update({ where: { id: current.runId }, data: { status: 'running' } });
      return true;
    });
  } catch (error) {
    const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
    const identity = preparationHash({ executionId, revision: progress.revision, detail });
    await prisma.taskGraphEvent.createMany({ data: [{ runId: before.node.runId, nodeId: before.nodeId,
      kind: 'execution_conditions_unavailable', idempotencyKey: `conditions-unavailable:${identity}`, payload: { executionId, detail } }], skipDuplicates: true });
    return false;
  }
}

/** Retry the fixed review, never the implementation, after approved conditions pass again. */
async function reconcileReviewConditions(nodeId: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true, run: true } });
  if (node.status !== 'attention' || !['running', 'attention'].includes(node.run.status) || !node.executions.length || node.executions.some(job => {
    const progress = executionProgress(job.dispatchMetadata);
    return !job.commit || !progress || !['architecture', 'acceptance'].includes(progress.phase) ||
      !['waiting_decision', 'waiting_for_user', 'exhausted'].includes(progress.state) || progress.lastFailure?.owner !== 'platform' || progress.lastFailure.requiresUserDecision === true;
  })) return false;
  const ids = node.executions.flatMap(job => { const binding = executionProgress(job.dispatchMetadata)?.review; return binding?.kind === 'running' ? [binding.taskRunId] : []; });
  const proof = await observeWriterSnapshot({ jobs: node.executions, taskRunIds: ids, scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) return false;
  try {
    const workspaces = await resolveReviewWorkspaces(node.executions);
    const inputs = await Promise.all(node.executions.map(job => prepareUpstreamInputs(job.id)));
    const spec = await prepareGraphSpecInput(node.run.snapshot as unknown as GraphDefinition);
    const output = await prepareAcceptanceRuntime(node.id, 'condition-recheck', workspaces);
    const runtime = await inspectSavedTaskRuntime({ taskId: `task-graph-review-${node.id}`, workspace: output.directory,
      approvedReadOnlyRoots: [...output.readOnlyPaths, ...spec.paths, ...inputs.flatMap(input => input.readOnlyPaths)],
      outputDirectory: output.directory, permissionConfig: output.permissionConfig });
    if (!await prisma.$transaction(tx => writerSnapshotMatches(tx, proof))) return false;
    const identity = preparationHash({ snapshot: node.run.snapshotHash, candidates: node.executions.map(job => [job.id, job.commit]),
      runtime: runtime.identity, inputs: inputs.map(input => input.manifest.hash), conditions: await executionConditionsVersion() });
    await scheduleVerificationRecovery(node.runId, node.key, `conditions:${identity}`);
    return true;
  } catch (error) {
    const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
    await prisma.taskGraphEvent.createMany({ data: [{ runId: node.runId, nodeId, kind: 'execution_conditions_unavailable',
      idempotencyKey: `review-conditions:${preparationHash({ nodeId, detail })}`, payload: { detail } }], skipDuplicates: true });
    return false;
  }
}
