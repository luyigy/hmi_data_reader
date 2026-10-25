import { validateResourceAdmission, preserveResourceReviewRuntime } from '../task-resources/graph-admission';
import { updateResourceApplication } from '../task-resources/access';
import { isImplementationInput } from './conversation-target';
import { approvedRuntimeUpgrade } from './approved-runtime-upgrade';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { resolveReviewWorkspaces } from './review-workspaces';
import { prepareAcceptanceRuntime } from './acceptance-runtime';
import { requireGraphRunActiveTx } from './run-control';
import { isCompletedNodeStatus, type GraphDefinition } from './domain';
import { prepareGraphSpecInput } from './spec-input';
import { prepareUpstreamInputs } from './upstream-inputs';
import { prepareGraphInspectionOutputForTask } from './output-task-context';
import { inspectSavedTaskRuntime } from './runtime-continuity';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { applyExecutionOutcomeTx, executionProgress, initialExecutionProgress, metadataWithProgress } from './execution-progress';
import { observeExecutionWriter, assertExecutionWriterExited } from './phase-worker';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { executionRetryLimits } from './retry-limits';
import { platformRepository } from '../platform-repository';
import { PreparationRejected, parsePreparationReceipt, preparationBindingTx, preparationHash, validatePreparationArtifacts, type PreparationReceipt } from './preparation-contract';
import { scheduleImplementationRecovery } from './implementation-result';
import { redactSensitiveText } from '../redact-sensitive';
import { observeTaskRunExit } from './task-run-exit-proof';
import { continuationWorkFingerprint } from './continuation-work';
import { ensureJobWorktree } from './worktree';
import { withRepositoryLock } from './repository-lock';
import { maxUnchangedWorkTurns } from './retry-limits';
import type { ExecutionPhase, ExecutionProgress } from './execution-progress';
import { pendingConversationInputs, authorizedConversationInput, authorizedMaterialHandoffInput } from './conversation-inbox';
import { currentWaitCause } from './waiting-cause';
import { assertPreparationTx } from './preparation-contract';
import { observeTaskRunWriter } from './writer-ownership';

export type AdmissionWake =
  | { source: 'resource_approval'; id: string; executionIds: string[] }
  | { source: 'conditions'; id: string; executionIds?: string[]; version?: string }
  | { source: 'operator'; id: string; preparedEventId?: string }
  | { source: 'conversation'; id: string; executionIds: string[]; inputIds: string[] }
  | { source: 'prepared_review'; id: string }
  | { source: 'materials'; id: string; executionIds: string[]; reservationId: string; expectedRevision: number };
export type AdmissionResult =
  | { kind: 'admitted'; eventId: string }
  | { kind: 'already_scheduled'; eventId: string }
  | { kind: 'deferred' | 'rejected' | 'unchanged'; reason: string };

export class AdmissionRefused extends Error {
  constructor(readonly result: Extract<AdmissionResult, { reason: string }>) {
    super(`Admission ${result.kind}: ${result.reason}`); this.name = 'AdmissionRefused';
  }
}

async function approvedScopeChange(job: TaskGraphExecution) {
  const decision = await prisma.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId,
    kind: { in: ['execution_outcome', 'implementation_blocked'] }, AND: [
      { payload: { path: ['executionId'], equals: job.id } }, { OR: [
        { kind: 'implementation_blocked' }, { payload: { path: ['outcome', 'kind'], equals: 'decision_required' } },
        { payload: { path: ['outcome', 'kind'], equals: 'waiting_for_user' } } ] } ] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!decision) return false;
  // A later timestamp is not proof that the same resource/saved candidate was approved.
  if (!job.childTaskId || !job.worktreePath || executionProgress(job.dispatchMetadata)?.lastFailure?.code === 'scope_change') return false;
  const { projectCapabilityContext } = await import('../project-capabilities/context');
  const context = await projectCapabilityContext({ taskId: job.childTaskId, workspace: job.worktreePath, executionId: job.id }).catch(() => null);
  if (!context?.approval || context.approval.kind !== 'change' || context.approval.originalClaim !== job.claimToken ||
      context.approval.candidateCommit !== executionProgress(job.dispatchMetadata)?.candidateCommit) return false;
  const approval = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: context.approval.id } });
  return approval.createdAt > decision.createdAt;
}

function admissionHold(progress: ExecutionProgress, wake: AdmissionWake, scopeApproved = false, conversationFinished = false): string | undefined {
  if (wake.source === 'conditions' && progress.lastFailure?.code === 'resource_application_failed') return 'resource_application_unresolved';
  if (wake.source === 'conditions' && progress.lastFailure?.code === 'agent_capability_missing') return 'agent_capability_unresolved';
  if (progress.state === 'ownership_attention' || progress.lastFailure?.code === 'ownership_mismatch') return 'ownership_unresolved';
  if (progress.conflictRepair || progress.lastFailure?.code === 'integration_conflict') return 'controlled_conflict_required';
  if (progress.conversation && !conversationFinished && !(wake.source === 'materials' && progress.conversation.reservationId === wake.reservationId)) return 'conversation_writer_reserved';
  const scopeResolved = wake.source === 'conditions' && scopeApproved && ['permission_required', 'scope_change'].includes(progress.lastFailure?.code || '');
  if (wake.source === 'conditions' && !scopeResolved && (progress.lastFailure?.requiresUserDecision === true ||
      ['permission_required', 'scope_change'].includes(progress.lastFailure?.code || '') ||
      progress.state === 'waiting_for_user' && (progress.waitingKind === 'question' || !progress.lastFailure))) return 'human_input_required';
}

async function observeAdmissionWriter(job: TaskGraphExecution) {
  const observed = await observeExecutionWriter(job);
  if (observed.kind !== 'unknown') return observed;
  try { await assertExecutionWriterExited(prisma, job); return { kind: 'exited' as const }; }
  catch { return observed; }
}

/** Discover a legacy checkpoint only from immutable delivery evidence and an actual exited native writer. No status or old budget is reset. */
async function discoverLegacyProgress(nodeId: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true, run: true } });
  for (const job of node.executions) {
    if (!['attention', 'integrated'].includes(job.status) || node.status !== 'attention' || executionProgress(job.dispatchMetadata) || !job.taskRunId || !job.childTaskId || !job.worktreePath) continue;
    const source = await prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: { in: ['implementation_blocked', 'node_delivery_reclassified'] },
      payload: { path: ['executionId'], equals: job.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const saved = source?.payload;
    if (!source || !saved || typeof saved !== 'object' || Array.isArray(saved) || saved.taskRunId !== job.taskRunId ||
        typeof saved.checkpointCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(saved.checkpointCommit) ||
        typeof saved.workspaceBase !== 'string' || !/^[a-f0-9]{40,64}$/.test(saved.workspaceBase)) continue;
    const run = await prisma.taskRun.findUnique({ where: { id: job.taskRunId } });
    if (run?.taskId !== job.childTaskId) continue;
    const proof = await observeWriterSnapshot({ jobs: [job], scope: 'execution', observeExecution: async original => original.taskRunId
      ? observeTaskRunWriter(original.taskRunId) : { kind: 'unknown', reason: 'Legacy task has no native writer identity' } });
    if (!proof.exited) continue;
    if (await graphGit(job.worktreePath, 'rev-parse', 'HEAD') !== saved.checkpointCommit ||
        await graphGit(job.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir') !==
        await graphGit(job.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) continue;
    const raw = saved.result;
    const result = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const progress: ExecutionProgress = { ...initialExecutionProgress(), phase: 'implement', state: 'waiting_decision',
      candidateCommit: saved.checkpointCommit, workspaceBase: saved.workspaceBase, taskRunId: job.taskRunId,
      conversationOwnerRunId: job.taskRunId, lastFailure: { code: typeof result.blockerKind === 'string' ? result.blockerKind : 'legacy_saved_work',
        detail: typeof result.note === 'string' ? result.note : typeof saved.reason === 'string' ? saved.reason : 'Recorded legacy checkpoint' } };
    await prisma.$transaction(async tx => {
      await requireGraphRunActiveTx(tx, node.runId);
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
      if (!await writerSnapshotMatches(tx, proof)) return;
      const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { run: true } });
      if (current.run.snapshotHash !== node.run.snapshotHash) return;
      await tx.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: job.claimToken || `legacy:${source.id}`,
        dispatchMetadata: metadataWithProgress(job.dispatchMetadata, progress) } });
      await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'execution_progress_discovered',
        idempotencyKey: `legacy-progress:${job.id}`, payload: { executionId: job.id, sourceEventId: source.id,
          candidateCommit: progress.candidateCommit, workspaceBase: progress.workspaceBase, taskRunId: job.taskRunId, writerExited: true } } });
    });
  }
}

export async function inspectImplementationConditions(job: TaskGraphExecution, progress: ExecutionProgress, snapshot: GraphDefinition, runId: string) {
  if (!job.worktreePath || !job.childTaskId || !progress.candidateCommit || !progress.workspaceBase) throw new PreparationRejected('Missing saved workspace or candidate identity');
  if (!await lstat(job.worktreePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    const metadata = job.dispatchMetadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.integrationRef !== 'string') throw new PreparationRejected('Missing original integration identity');
    const integrationRef = metadata.integrationRef;
    const restored = await withRepositoryLock(job.repository, () => ensureJobWorktree({ repoPath: job.repository, runId, jobId: job.id,
      baseRef: integrationRef, baseCommit: progress.workspaceBase!, resumeCommit: progress.candidateCommit!, worktreePath: job.worktreePath! }));
    if (restored.path !== job.worktreePath || restored.branch !== job.worktreeBranch) throw new PreparationRejected('Restored workspace identity mismatch');
  }
  if (await graphGit(job.worktreePath, 'rev-parse', 'HEAD') !== progress.candidateCommit) throw new PreparationRejected('Saved candidate HEAD changed');
  if (await graphGit(job.worktreePath, 'rev-parse', '--verify', 'MERGE_HEAD').then(() => true, () => false)) throw new PreparationRejected('Pending merge requires controlled conflict repair');
  const inputs = await prepareUpstreamInputs(job.id);
  const spec = await prepareGraphSpecInput(snapshot);
  const output = await prepareGraphInspectionOutputForTask(job.childTaskId, job.id);
  const runtime = await inspectSavedTaskRuntime({ taskId: job.childTaskId, workspace: job.worktreePath,
    approvedReadOnlyRoots: [...inputs.readOnlyPaths, ...spec.paths, ...output.readOnlyPaths], outputDirectory: output.directory, priorArtifacts: output.priorArtifacts });
  return { inputHash: inputs.manifest.hash, runtimeIdentity: runtime.identity };
}

async function deferAdmission(job: TaskGraphExecution, runId: string, progress: ExecutionProgress,
  proof: Awaited<ReturnType<typeof observeWriterSnapshot>>, exit: Awaited<ReturnType<typeof observeTaskRunExit>> | undefined,
  wake: AdmissionWake, detail: string) {
  const key = preparationHash({ executionId: job.id, revision: progress.revision, detail, wakeId: wake.id });
      const attempts = await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'execution_outcome', AND: [
        { payload: { path: ['executionId'], equals: job.id } }, { payload: { path: ['outcome', 'kind'], equals: 'admission_deferred' } } ] } });
      const retryAt = new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(9, attempts))).toISOString();
      await prisma.$transaction(async tx => {
        await requireGraphRunActiveTx(tx, runId);
        await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
        if (!await writerSnapshotMatches(tx, proof)) return;
        if (!(wake.source === 'operator' && wake.preparedEventId) && wake.source !== 'prepared_review') await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken || '', expectedRevision: progress.revision,
          outcomeId: `admission-deferred:${key}`, outcome: { kind: 'admission_deferred', retryAt,
            failure: progress.lastFailure?.blockerCause ? progress.lastFailure
              : { ...(progress.lastFailure || { code: 'environment_failed', owner: 'platform' as const, requiresUserDecision: false }), detail } } }, exit, job);
        await tx.taskGraphEvent.createMany({ data: [{ runId: runId, nodeId: job.nodeId, kind: 'execution_conditions_unavailable',
          idempotencyKey: `conditions-unavailable:${key}`, payload: { executionId: job.id, detail, retryAt, wakeId: wake.id,
            version: wake.source === 'conditions' ? wake.version || '' : '' } }], skipDuplicates: true });
      });
}

/** One admission boundary; triggers describe work, never grant resources. Slow observations stay outside the transaction. */
export async function admitNode(nodeId: string, wake: AdmissionWake): Promise<AdmissionResult> {
  if (!wake.id.trim()) throw new PreparationRejected('Admission wake requires a durable identity');
  await discoverLegacyProgress(nodeId);
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: { orderBy: { id: 'asc' } }, run: { include: { parentTask: { select: { ownerUserId: true } } } } } });
  const receiptKey = wake.source === 'operator' ? `node:${node.key}:${node.executions.some(job => {
    const p = executionProgress(job.dispatchMetadata); return p && ['architecture', 'acceptance'].includes(p.phase);
  }) ? 'verification' : 'implementation'}-recovery:${wake.id}` : `admission-wake:${node.id}:${wake.source}:${wake.id}`;
  const receipt = await prisma.taskGraphEvent.findFirst({ where: { runId: node.runId, idempotencyKey: wake.source === 'operator'
    ? { in: [`node:${node.key}:implementation-recovery:${wake.id}`, `node:${node.key}:verification-recovery:${wake.id}`] } : receiptKey } });
  if (receipt) return { kind: 'already_scheduled', eventId: receipt.id };
  const delayed = await prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: 'execution_conditions_unavailable',
    payload: { path: ['wakeId'], equals: wake.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const delay = delayed?.payload;
  if (wake.source !== 'conditions' && delay && typeof delay === 'object' && !Array.isArray(delay) &&
      typeof delay.retryAt === 'string' && Date.parse(delay.retryAt) > Date.now()) return { kind: 'deferred', reason: 'retry_not_due' };
  const preparedReview = wake.source === 'prepared_review' ? await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: wake.id } }) : null;
  if (preparedReview && (preparedReview.kind !== 'platform_review_preparation' || preparedReview.nodeId !== nodeId || preparedReview.runId !== node.runId)) throw new PreparationRejected('Prepared review target mismatch');
  const reviewReceipt = preparedReview?.payload;
  if (preparedReview) {
    if (!reviewReceipt || typeof reviewReceipt !== 'object' || Array.isArray(reviewReceipt) || !('receipt' in reviewReceipt)) throw new PreparationRejected('Invalid prepared review evidence');
    await validatePreparationArtifacts(parsePreparationReceipt(reviewReceipt.receipt).artifacts);
  }
  const prepared = wake.source === 'operator' && wake.preparedEventId
    ? parsePreparationReceipt((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: wake.preparedEventId } })).payload) : undefined;
  if (prepared) {
    if (prepared.runId !== node.runId || prepared.nodeKey !== node.key || wake.id !== `prepared:${'preparedEventId' in wake && wake.preparedEventId}`) throw new PreparationRejected('Preparation request identity mismatch');
    await validatePreparationArtifacts(prepared.artifacts);
  }
  const correctedDelivery = wake.source === 'operator' && node.status === 'attention' && node.run.status.startsWith('completed') &&
    await prisma.taskGraphEvent.count({ where: { nodeId, kind: 'node_delivery_reclassified' } }) > 0;
  if (!['running', 'attention'].includes(node.run.status) && !correctedDelivery) return { kind: 'deferred', reason: 'run_paused_or_complete' };
  if (!['attention', 'claimed'].includes(node.status)) return { kind: 'deferred', reason: 'node_not_waiting' };
  const resolvedScopes = new Set<string>();
  if (wake.source === 'conditions') for (const job of node.executions) {
    const code = executionProgress(job.dispatchMetadata)?.lastFailure?.code;
    if (['permission_required', 'scope_change'].includes(code || '') && await approvedScopeChange(job)) resolvedScopes.add(job.id);
  }
  // Historical reservations do not own a Writer after the read-only turn and its handler finish.
  const finishedConversations = new Set<string>();
  for (const job of node.executions) {
    const conversation = executionProgress(job.dispatchMetadata)?.conversation;
    if (conversation?.kind !== 'running' || !job.childTaskId) continue;
    const [turn, finished] = await Promise.all([
      prisma.taskRun.findFirst({ where: { id: conversation.taskRunId, taskId: job.childTaskId, status: { in: ['completed', 'failed', 'stopped', 'interrupted'] } }, select: { id: true } }),
      prisma.taskGraphEvent.findFirst({ where: { runId: node.runId, nodeId, kind: 'conversation_followup_finished', idempotencyKey: `conversation-followup:${conversation.reservationId}:finished` }, select: { id: true } }),
    ]);
    if (turn && finished) finishedConversations.add(job.id);
  }
  if (wake.source === 'resource_approval') await validateResourceAdmission(wake.id, nodeId, wake.executionIds);
  const wholeReview = node.executions.every(job => { const p = executionProgress(job.dispatchMetadata); return p && ['architecture', 'acceptance'].includes(p.phase); });
  const candidates = node.executions.filter(job => (job.status === 'attention' || job.status === 'integrated' && executionProgress(job.dispatchMetadata) && node.status === 'attention') &&
    (wholeReview || !('executionIds' in wake) || !wake.executionIds || wake.executionIds.includes(job.id)));
  let lastReason = 'no_pending_work';
  const observations: { job: (typeof node.executions)[number]; progress: ExecutionProgress;
    proof: Awaited<ReturnType<typeof observeWriterSnapshot>>; exit: Awaited<ReturnType<typeof observeTaskRunExit>> | undefined;
    review: boolean; conditions: { inputHash: string; runtimeIdentity: string }; conditionKey: string }[] = [];
  for (const job of candidates) {
    const progress = executionProgress(job.dispatchMetadata);
    if (!progress || !job.claimToken) { lastReason = 'missing_saved_progress_or_claim'; continue; }
    const hold = admissionHold(progress, wake, resolvedScopes.has(job.id), finishedConversations.has(job.id));
    if (hold) { lastReason = hold; continue; }
    if (!['waiting_decision', 'waiting_for_user', 'exhausted'].includes(progress.state) && !(job.status === 'integrated' && ['architecture', 'acceptance'].includes(progress.phase) && ['active', 'ready'].includes(progress.state))) { lastReason = 'not_waiting'; continue; }
    if (wake.source === 'materials' && (progress.revision !== wake.expectedRevision || progress.conversation?.reservationId !== wake.reservationId)) { lastReason = 'material_reservation_changed'; continue; }
    if (wake.source === 'materials') {
      const reservation = await prisma.taskGraphEvent.findFirst({ where: { id: wake.reservationId, nodeId, runId: node.runId, kind: 'conversation_followup_reserved' } });
      const payload = reservation?.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.executionId !== job.id ||
          !Array.isArray(payload.inputIds) || !payload.inputIds.length || !payload.inputIds.every((id): id is string => typeof id === 'string') || !job.childTaskId) {
        lastReason = 'material_reservation_changed'; continue;
      }
      const { conversationInputsByIds } = await import('./conversation-inbox');
      const inputs = await conversationInputsByIds(prisma, node.runId, job.id, payload.inputIds);
      if (inputs.length !== payload.inputIds.length || !(await Promise.all(inputs.map(input => authorizedMaterialHandoffInput(input, job.childTaskId!, node.run.parentTask.ownerUserId)))).every(Boolean)) {
        lastReason = 'input_not_authorized'; continue;
      }
      const cause = await currentWaitCause(job, progress);
      if (!cause) { lastReason = 'unknown_wait_cause'; continue; }
      if (cause.requiresUserDecision || ['permission_required', 'scope_change'].includes(cause.code)) { lastReason = 'human_input_required'; continue; }
    }
    if (wake.source === 'conversation') {
      const inputs = (await pendingConversationInputs(prisma, node.runId, job.id)).filter(isImplementationInput);
      if (!inputs.length || inputs.map(input => input.id).join() !== wake.inputIds.join() || !job.childTaskId ||
          !(await Promise.all(inputs.map(input => authorizedConversationInput(input, job.childTaskId!, node.run.parentTask.ownerUserId)))).every(Boolean)) {
        lastReason = 'input_not_authorized'; continue;
      }
    }
    const isReview = progress.phase === 'architecture' || progress.phase === 'acceptance';
    const reviewRunIds = isReview ? node.executions.flatMap(item => {
      const binding = executionProgress(item.dispatchMetadata)?.review; return binding?.kind === 'running' ? [binding.taskRunId] : [];
    }) : [];
    if (isReview && node.executions.some(item => {
      const p = executionProgress(item.dispatchMetadata); return !p || !['architecture', 'acceptance'].includes(p.phase) || admissionHold(p, wake, resolvedScopes.has(item.id), finishedConversations.has(item.id));
    })) { lastReason = 'review_generation_not_ready'; continue; }
    const conversationRunIds = (isReview ? node.executions : [job]).flatMap(item => {
      const conversation = executionProgress(item.dispatchMetadata)?.conversation; return conversation?.kind === 'running' ? [conversation.taskRunId] : [];
    });
    const proof = await observeWriterSnapshot({ jobs: isReview ? node.executions : [job], taskRunIds: [...reviewRunIds, ...conversationRunIds], scope: 'execution', observeExecution: observeAdmissionWriter });
    if (!proof.exited) { lastReason = 'writer_not_exited'; continue; }
    const exit = job.taskRunId ? await observeTaskRunExit(job.taskRunId) : undefined;
    try {
      const review = progress.phase === 'architecture' || progress.phase === 'acceptance';
      let conditions: { inputHash: string; runtimeIdentity: string };
      if (review) {
        if (node.executions.some(item => !item.commit || !['integrated', 'attention'].includes(item.status))) { lastReason = 'review_candidate_incomplete'; continue; }
        const workspaces = await resolveReviewWorkspaces(node.executions);
        const inputs = await Promise.all(node.executions.map(item => prepareUpstreamInputs(item.id)));
        const spec = await prepareGraphSpecInput(node.run.snapshot as unknown as GraphDefinition);
        const output = await prepareAcceptanceRuntime(node.id, 'condition-recheck', workspaces);
        const runtime = await inspectSavedTaskRuntime({ taskId: `task-graph-review-${node.id}`, workspace: output.directory,
          approvedReadOnlyRoots: [...output.readOnlyPaths, ...spec.paths, ...inputs.flatMap(input => input.readOnlyPaths)],
          outputDirectory: output.directory, permissionConfig: output.permissionConfig });
        conditions = { inputHash: preparationHash(inputs.map(input => input.manifest.hash)), runtimeIdentity: runtime.identity };
      } else conditions = await inspectImplementationConditions(job, progress, node.run.snapshot as unknown as GraphDefinition, node.runId);
      const identity = preparationHash({ executionId: job.id, candidate: progress.candidateCommit, scope: node.run.snapshotHash,
        ...conditions });
      const conditionKey = `conditions-ready:${job.id}:${identity}`;
      if (wake.source === 'conditions' && await prisma.taskGraphEvent.count({ where: { runId: node.runId,
        kind: 'execution_conditions_ready', OR: [{ idempotencyKey: conditionKey }, { AND: [
          { payload: { path: ['executionId'], equals: job.id } },
          { payload: { path: ['candidateCommit'], equals: progress.candidateCommit || '' } },
          { payload: { path: ['inputHash'], equals: conditions.inputHash } },
          { payload: { path: ['runtimeIdentity'], equals: conditions.runtimeIdentity } },
        ] }] } })) { lastReason = 'conditions_unchanged'; await deferAdmission(job, node.runId, progress, proof, exit, wake, lastReason); if (review) break; continue; }
      if (wake.source === 'conditions' && !review && progress.continuation && progress.continuation.unchangedTurns >= (progress.lastFailure?.code === 'invalid_result' ? executionRetryLimits.formatAttempts : maxUnchangedWorkTurns) &&
          progress.continuation.fingerprint === await continuationWorkFingerprint(job.id, progress.candidateCommit!) && !await approvedRuntimeUpgrade(job)) {
        lastReason = 'work_unchanged'; await deferAdmission(job, node.runId, progress, proof, exit, wake, lastReason); continue;
      }
      observations.push({ job, progress, proof, exit, review, conditions, conditionKey });
    } catch (error) {
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      await deferAdmission(job, node.runId, progress, proof, exit, wake, detail);
      lastReason = detail;
      if (isReview) break;
    }
  }
  if (wholeReview && observations.length && observations.length !== node.executions.length) return { kind: 'deferred', reason: 'review_generation_not_ready' };
  if (!observations.length) return { kind: ['conditions_unchanged', 'work_unchanged'].includes(lastReason) ? 'unchanged' : 'deferred', reason: lastReason };
  return prisma.$transaction(async tx => {
    await requireGraphRunActiveTx(tx, node.runId);
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const repeated = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: receiptKey } } });
    if (repeated) return { kind: 'already_scheduled', eventId: repeated.id };
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { run: true, executions: true } });
    if (!['attention', 'claimed'].includes(current.status) || current.run.snapshotHash !== node.run.snapshotHash ||
        current.executions.map(job => job.id).sort().join() !== node.executions.map(job => job.id).sort().join()) return { kind: 'deferred', reason: 'node_identity_changed' };
    const dependencies = await tx.taskGraphNode.findMany({ where: { runId: node.runId, key: { in: current.dependsOn } } });
    if (dependencies.length !== current.dependsOn.length || !dependencies.every(item => isCompletedNodeStatus(item.status))) return { kind: 'deferred', reason: 'upstream_not_accepted' };
    if (wake.source === 'resource_approval') {
      const approval = await validateResourceAdmission(wake.id, nodeId, wake.executionIds, tx);
      await preserveResourceReviewRuntime(tx, approval, `admit:${wake.id}`);
    }
    for (const entry of observations) if (!await writerSnapshotMatches(tx, entry.proof)) return { kind: 'deferred', reason: 'writer_or_candidate_changed' };
    if (preparedReview) {
      const original = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: preparedReview.id } });
      if (preparationHash(original.payload) !== preparationHash(reviewReceipt)) throw new PreparationRejected('Prepared review evidence changed');
      const bound = original.payload;
      if (!bound || typeof bound !== 'object' || Array.isArray(bound)) throw new PreparationRejected('Invalid prepared review binding');
      for (const entry of observations) if (bound.executionId !== entry.job.id || bound.claimToken !== entry.job.claimToken ||
          bound.expectedRevision !== entry.progress.revision || bound.candidateCommit !== entry.job.commit) throw new PreparationRejected('Stale prepared review identity');
    }
    if (prepared && wake.source === 'operator' && wake.preparedEventId) await assertPreparationTx(tx, node.runId, node.key, wake.preparedEventId, prepared);
    if (wake.source === 'conversation') {
      const owner = await tx.task.findUniqueOrThrow({ where: { id: current.run.parentTaskId }, select: { ownerUserId: true } });
      if (owner.ownerUserId !== node.run.parentTask.ownerUserId) return { kind: 'deferred', reason: 'input_owner_changed' };
      const inputs = (await Promise.all(observations.map(entry => pendingConversationInputs(tx, node.runId, entry.job.id)))).flat().filter(isImplementationInput);
      if (inputs.map(input => input.id).join() !== wake.inputIds.join() ||
          !(await Promise.all(inputs.map(input => authorizedConversationInput(input, observations.find(entry => entry.job.id === input.executionId)!.job.childTaskId!, owner.ownerUserId, tx)))).every(Boolean)) return { kind: 'deferred', reason: 'input_identity_changed' };
    }
    if (wake.source === 'materials') {
      const owner = await tx.task.findUniqueOrThrow({ where: { id: current.run.parentTaskId }, select: { ownerUserId: true } });
      if (owner.ownerUserId !== node.run.parentTask.ownerUserId) return { kind: 'deferred', reason: 'input_owner_changed' };
      const reservation = await tx.taskGraphEvent.findUnique({ where: { id: wake.reservationId } });
      const payload = reservation?.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.inputIds) ||
          !payload.inputIds.every((id): id is string => typeof id === 'string')) return { kind: 'deferred', reason: 'material_reservation_changed' };
      const { conversationInputsByIds } = await import('./conversation-inbox');
      for (const { job } of observations) {
        const inputs = await conversationInputsByIds(tx, node.runId, job.id, payload.inputIds);
        if (inputs.length !== payload.inputIds.length || !(await Promise.all(inputs.map(input => authorizedMaterialHandoffInput(input, job.childTaskId!, owner.ownerUserId, tx)))).every(Boolean)) return { kind: 'deferred', reason: 'input_identity_changed' };
      }
    }
    for (const entry of observations) {
      const { job, progress, exit, review } = entry;
      const phase: ExecutionPhase = progress.phase;
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken!, expectedRevision: progress.revision,
        outcomeId: `admit:${wake.source}:${wake.id}:${progress.revision}`, outcome: { kind: 'admitted', requestId: wake.id,
          stage: review ? { kind: 'review', phase: progress.phase === 'architecture' ? 'architecture' : 'acceptance', claimKey: `admit:${wake.id}` }
            : { kind: 'implementation', phase } } }, exit, job);
      await tx.taskGraphEvent.createMany({ data: [{ runId: node.runId, nodeId, kind: 'execution_conditions_ready',
        idempotencyKey: entry.conditionKey, payload: { executionId: job.id, revision: progress.revision, candidateCommit: progress.candidateCommit,
          claimToken: job.claimToken, ...entry.conditions, writerExited: true } }], skipDuplicates: true });
      if (wake.source === 'conversation') await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId, kind: 'conversation_turn_scheduled',
        idempotencyKey: `conversation-turn:${job.id}:${progress.revision}`, payload: { executionId: job.id, inputIds: wake.inputIds,
          previousClaimToken: job.claimToken, previousTaskRunId: job.taskRunId, expectedRevision: progress.revision, revision: progress.revision + 1,
          candidateCommit: progress.candidateCommit, workspaceBase: progress.workspaceBase, worktreePath: job.worktreePath, writerExited: true } } });
    }
    const reviewing = observations.every(entry => entry.review);
    const otherWriter = current.executions.some(job => job.status === 'claimed');
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: reviewing ? 'verifying' : otherWriter ? 'claimed' : 'ready', passedAt: null,
      ...(!reviewing && !otherWriter ? { claimToken: null, claimedAt: null } : {}) } });
    await tx.taskGraphRun.update({ where: { id: node.runId }, data: { status: 'running' } });
    const event = await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId,
      kind: wake.source === 'operator' ? reviewing ? 'verification_recovery_requested' : 'implementation_recovery_scheduled' : 'node_admitted', idempotencyKey: receiptKey,
      payload: { source: wake.source, wakeId: wake.id, executions: observations.map(({ job, progress }) => ({ id: job.id, revision: progress.revision,
        checkpointCommit: progress.candidateCommit, workspaceBase: progress.workspaceBase, previousTaskRunId: job.taskRunId, previousSessionId: job.sessionId,
        previousClaimToken: job.claimToken, previousCommit: job.commit, previousEvidence: job.evidence, previousDispatch: job.dispatchMetadata })) } } });
    if (wake.source === 'resource_approval') await updateResourceApplication(wake.id, { state: 'scheduled', eventId: event.id }, tx);
    const requests = await tx.taskGraphEvent.findMany({ where: { nodeId, kind: 'conversation_review_recovery_requested' }, select: { id: true } });
    for (const request of requests) {
      const key = `conversation:review-recovery:${request.id}:started`;
      if (await tx.taskGraphEvent.count({ where: { runId: node.runId, idempotencyKey: key + ':finished' } })) continue;
      await tx.taskGraphEvent.createMany({ data: [
        { runId: node.runId, nodeId, kind: 'conversation_review_recovery_started', idempotencyKey: key, payload: { receiptId: event.id } },
        { runId: node.runId, nodeId, kind: 'conversation_review_recovery_finished', idempotencyKey: key + ':finished', payload: { receiptId: event.id } },
      ], skipDuplicates: true });
    }
    if (wake.source === 'operator' && wake.preparedEventId) await tx.taskGraphEvent.createMany({ data: [{ runId: node.runId, nodeId,
      kind: 'platform_preparation_consumed', idempotencyKey: `preparation-consumed:${wake.preparedEventId}`,
      payload: { preparationEventId: wake.preparedEventId, kind: 'scheduled', eventId: event.id } }], skipDuplicates: true });
    if (wake.source === 'prepared_review') await tx.taskGraphEvent.createMany({ data: [{ runId: node.runId, nodeId,
      kind: 'platform_preparation_consumed', idempotencyKey: `review-preparation-consumed:${wake.id}`,
      payload: { preparationEventId: wake.id, kind: 'scheduled', eventId: event.id } }], skipDuplicates: true });
    return { kind: 'admitted', eventId: event.id };
  });
}

/** Compatibility name for callers; all actual admission is shared. */
export async function reconcileExecutionConditions(executionId: string) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
  const progress = executionProgress(job.dispatchMetadata);
  if (progress && ['architecture', 'acceptance'].includes(progress.phase)) {
    const first = await prisma.taskGraphExecution.findFirst({ where: { nodeId: job.nodeId }, orderBy: { id: 'asc' }, select: { id: true } });
    if (first?.id !== job.id) return false;
  }
  const preparations = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: { in: ['platform_preparation_registered', 'platform_review_preparation'] } }, select: { id: true, kind: true } });
  for (const receipt of preparations) if (!await prisma.taskGraphEvent.count({ where: { runId: job.node.runId, idempotencyKey: `${receipt.kind === 'platform_review_preparation' ? 'review-preparation-consumed' : 'preparation-consumed'}:${receipt.id}` } })) return false;
  const dependencies = await prisma.taskGraphNode.findMany({ where: { runId: job.node.runId, key: { in: job.node.dependsOn } },
    select: { id: true, status: true, updatedAt: true } });
  const changes = await prisma.taskGraphEvent.findMany({ where: { runId: job.node.runId, OR: [
    { kind: 'run_user_resumed' },
    { kind: { in: ['node_verified', 'delivered_unverified'] }, nodeId: { in: dependencies.map(node => node.id) } },
    { kind: 'project_capability_scope_approved', payload: { path: ['executionId'], equals: job.id } },
  ] }, select: { id: true }, orderBy: { id: 'asc' } });
  const version = preparationHash({ upstreamMaxBytes: process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES || '268435456', changes, dependencies });
  const unavailable = await prisma.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId, kind: 'execution_conditions_unavailable',
    payload: { path: ['executionId'], equals: job.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const last = unavailable?.payload;
  if (progress?.nextRetryAt && Date.parse(progress.nextRetryAt) > Date.now() && last && typeof last === 'object' && !Array.isArray(last) && last.version === version) return false;
  const result = await admitNode(job.nodeId, { source: 'conditions', id: `${job.id}:${progress?.revision}`, executionIds: [job.id], version });
  return result.kind === 'admitted';
}

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
  const events = await prisma.taskGraphEvent.findMany({ where: { runId, kind: { in: ['platform_preparation_registered', 'platform_review_preparation'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const event of events) {
    const key = `${event.kind === 'platform_review_preparation' ? 'review-preparation-consumed' : 'preparation-consumed'}:${event.id}`;
    if (await prisma.taskGraphEvent.count({ where: { runId, idempotencyKey: key } })) continue;
    let result: { kind: string; eventId?: string; reason?: string };
    try {
      if (event.kind === 'platform_review_preparation') {
        if (!event.nodeId) throw new PreparationRejected('Prepared review has no node');
        const admitted = await admitNode(event.nodeId, { source: 'prepared_review', id: event.id });
        if (admitted.kind !== 'admitted' && admitted.kind !== 'already_scheduled') continue;
        result = { kind: 'scheduled', eventId: admitted.eventId };
      } else {
      const receipt = parsePreparationReceipt(event.payload);
      result = await scheduleImplementationRecovery(runId, receipt.nodeKey, `prepared:${event.id}`, event.id);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const controlledRejection = error instanceof PreparationRejected || error instanceof AdmissionRefused && error.result.kind === 'rejected';
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
  const proof = await observeWriterSnapshot({ jobs: before.executions, taskRunIds: reviews.map(review => review.id), scope: 'execution', observeExecution: observeAdmissionWriter });
  if (!proof.exited) throw new Error('Original implementation or reviewer writer has not exited');
  if (await graphGit(platformDirectory, 'rev-parse', 'HEAD') !== remediationCommit) throw new Error('Remediation code changed before publication');
  const registered = await prisma.$transaction(async tx => {
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
    return { kind: 'registered', eventId: event.id };
  });
  if (registered.kind === 'registered') await admitNode(before.id, { source: 'prepared_review', id: registered.eventId });
  return registered;
}
