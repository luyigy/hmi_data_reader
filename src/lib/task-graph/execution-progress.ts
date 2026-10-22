import { observeTaskRunExit, taskRunExitMatches, type TaskRunExitProof } from './task-run-exit-proof';
import { requireGraphNodeActiveTx } from './run-control';
import { parseGraphWriter, type GraphWriter } from './writer-ownership';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type TaskGraphExecution } from '@prisma/client';
import { prisma } from '../prisma';
import { parseConflictRepair, type ConflictRepair } from './conflict-repair';
import { executionRetryLimits, maxUnchangedWorkTurns } from './retry-limits';

export type ExecutionPhase = 'prepare' | 'implement' | 'collect_result' | 'check' | 'integrate' | 'architecture' | 'acceptance';
export type ExecutionFailure = { blockerCause?: 'missing_capability' | 'transient'; code: string; detail: string; checkId?: string; command?: string[]; fingerprint?: string; tree?: string; blockedPhase?: 'implementation' | 'input_preparation' | 'service_runtime'; action?: string; owner?: 'platform' | 'implementer' | 'user'; requiresUserDecision?: boolean; affectedPaths?: string[] };
export type GraphReviewBinding = { phase: 'architecture' | 'acceptance'; claimKey: string; candidateCommit: string } & ({ kind: 'ready' } | { kind: 'running'; taskRunId: string });
export type ExecutionProgress = {
  version: 1; revision: number; phase: ExecutionPhase;
  review?: GraphReviewBinding;
  worker?: GraphWriter;
  workerReleasedAt?: string;
  state: 'active' | 'ready' | 'waiting_for_user' | 'waiting_decision' | 'exhausted' | 'ownership_attention';
  conversationOwnerRunId?: string;
  waitingMessage?: string;
  waitingKind?: 'question' | 'answered';
  conversation?: { kind: 'reserved'; reservationId: string } | { kind: 'running'; reservationId: string; taskRunId: string };
  workspaceBase?: string; candidateCommit?: string; runtimeDirectory?: string; taskRunId?: string;
  repairAttempts: number; formatAttempts: number; platformAttempts: number; integrationAttempts: number;
  nextRetryAt?: string; lastFailure?: ExecutionFailure;
  continuation?: { fingerprint: string; unchangedTurns: number };
  conflictRepair?: ConflictRepair;
};
export type ExecutionOutcome =
  | { kind: 'continue_work'; note: string; fingerprint: string }
  | { kind: 'checkpoint'; phase: ExecutionPhase; workspaceBase?: string; candidateCommit?: string; runtimeDirectory?: string; worker?: GraphWriter; conflictRepair?: ConflictRepair | null }
  | { kind: 'repair_required'; failure: ExecutionFailure; conflictRepair?: ConflictRepair }
  | { kind: 'result_incomplete'; failure: ExecutionFailure }
  | { kind: 'platform_retry'; failure: ExecutionFailure }
  | { kind: 'integration_stale'; failure: ExecutionFailure }
  | { kind: 'review_resumed'; claimKey: string }
  | { kind: 'waiting_for_user'; note: string; result?: 'question' | 'answered' }
  | { kind: 'review_platform_prepared'; preparationEventId: string }
  | { kind: 'review_retry'; failure: ExecutionFailure; claimKey: string; phase?: 'architecture' | 'acceptance' }
  | { kind: 'operator_resume'; requestId: string }
  | { kind: 'delivery_reclassified'; authorization: string; failure: ExecutionFailure }
  | { kind: 'decision_required'; failure: ExecutionFailure }
  | { kind: 'retry_exhausted'; failure: ExecutionFailure }
  | { kind: 'integrated'; commit: string; evidence: Prisma.InputJsonValue };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(choice => choice === value);
  if (found === undefined) throw new Error('Invalid execution progress enum');
  return found;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid execution progress counter');
  return value;
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length) throw new Error('Invalid execution progress text');
  return value;
}
function optionalCommit(value: unknown): string | undefined {
  const text = optionalText(value);
  if (text !== undefined && !/^[0-9a-f]{40,64}$/.test(text)) throw new Error('Invalid execution progress commit');
  return text;
}
export function executionProgress(metadata: unknown): ExecutionProgress | null {
  const raw = record(metadata).progress;
  if (raw === undefined) return null;
  const value = record(raw);
  if (value.version !== 1) throw new Error('Unsupported execution progress version');
  const progress: ExecutionProgress = {
    version: 1, revision: count(value.revision),
    phase: enumeration(value.phase, ['prepare', 'implement', 'collect_result', 'check', 'integrate', 'architecture', 'acceptance']),
    state: enumeration(value.state, ['active', 'ready', 'waiting_for_user', 'waiting_decision', 'exhausted', 'ownership_attention']),
    repairAttempts: count(value.repairAttempts), formatAttempts: count(value.formatAttempts), platformAttempts: count(value.platformAttempts), integrationAttempts: value.integrationAttempts === undefined ? 0 : count(value.integrationAttempts),
  };
  if (value.continuation !== undefined) {
    const saved = record(value.continuation);
    if (typeof saved.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(saved.fingerprint)) throw new Error('Invalid work continuation fingerprint');
    progress.continuation = { fingerprint: saved.fingerprint, unchangedTurns: count(saved.unchangedTurns) };
  }
  const workspaceBase = optionalCommit(value.workspaceBase), candidateCommit = optionalCommit(value.candidateCommit);
  const runtimeDirectory = optionalText(value.runtimeDirectory), taskRunId = optionalText(value.taskRunId), nextRetryAt = optionalText(value.nextRetryAt);
  if (workspaceBase) progress.workspaceBase = workspaceBase;
  if (candidateCommit) progress.candidateCommit = candidateCommit;
  if (runtimeDirectory) progress.runtimeDirectory = runtimeDirectory;
  if (value.conflictRepair !== undefined) progress.conflictRepair = parseConflictRepair(value.conflictRepair);
  if (taskRunId) progress.taskRunId = taskRunId;
  if (value.conversationOwnerRunId !== undefined) progress.conversationOwnerRunId = optionalText(value.conversationOwnerRunId);
  if (value.waitingMessage !== undefined) progress.waitingMessage = optionalText(value.waitingMessage);
  if (value.waitingKind !== undefined) progress.waitingKind = enumeration<'question' | 'answered'>(value.waitingKind, ['question', 'answered']);
  if (value.conversation !== undefined) {
    const conversation = record(value.conversation);
    const reservationId = optionalText(conversation.reservationId);
    if (!reservationId) throw new Error('Conversation reservation missing');
    if (conversation.kind === 'reserved') progress.conversation = { kind: 'reserved', reservationId };
    else if (conversation.kind === 'running' && typeof conversation.taskRunId === 'string') progress.conversation = { kind: 'running', reservationId, taskRunId: conversation.taskRunId };
    else throw new Error('Invalid conversation phase owner');
  }
  if (nextRetryAt) {
    if (!Number.isFinite(Date.parse(nextRetryAt))) throw new Error('Invalid retry deadline');
    progress.nextRetryAt = nextRetryAt;
  }
  if (value.worker !== undefined) {
    const worker = parseGraphWriter(value.worker);
    if (!worker) throw new Error('Invalid phase worker identity');
    progress.worker = worker;
    if (value.workerReleasedAt !== undefined) {
      const releasedAt = optionalText(value.workerReleasedAt);
      if (!releasedAt || !Number.isFinite(Date.parse(releasedAt))) throw new Error('Invalid phase worker release');
      progress.workerReleasedAt = releasedAt;
    }
  }
  if (value.review !== undefined) {
    const review = record(value.review);
    const phase = enumeration(review.phase, ['architecture', 'acceptance']);
    const candidateCommit = optionalCommit(review.candidateCommit);
    if (!candidateCommit) throw new Error('Review candidate missing');
    const claimKey = optionalText(review.claimKey);
    if (!claimKey) throw new Error('Review claim key missing');
    const kind = enumeration(review.kind, ['running', 'ready']);
    if (kind === 'running') {
      const taskRunId = optionalText(review.taskRunId);
      if (!taskRunId) throw new Error('Review TaskRun missing');
      progress.review = { phase, claimKey, kind, taskRunId, candidateCommit };
    } else progress.review = { phase, claimKey, kind, candidateCommit };
  }
  if (value.lastFailure !== undefined) {
    const failure = record(value.lastFailure);
    if (typeof failure.code !== 'string' || typeof failure.detail !== 'string') throw new Error('Invalid execution failure');
    progress.lastFailure = { code: failure.code, detail: failure.detail };
    if (failure.blockerCause !== undefined) progress.lastFailure.blockerCause = enumeration(failure.blockerCause, ['missing_capability', 'transient'] as const);
    if (failure.action !== undefined) progress.lastFailure.action = optionalText(failure.action);
    if (failure.owner !== undefined) progress.lastFailure.owner = enumeration(failure.owner, ['platform', 'implementer', 'user'] as const);
    if (failure.requiresUserDecision !== undefined) {
      if (typeof failure.requiresUserDecision !== 'boolean') throw new Error('Invalid execution decision flag');
      progress.lastFailure.requiresUserDecision = failure.requiresUserDecision;
    }
    if (failure.affectedPaths !== undefined) {
      if (!Array.isArray(failure.affectedPaths) || !failure.affectedPaths.every(item => typeof item === 'string' && item.length)) throw new Error('Invalid execution affected paths');
      progress.lastFailure.affectedPaths = failure.affectedPaths;
    }
    if (failure.blockedPhase !== undefined) progress.lastFailure.blockedPhase = enumeration(failure.blockedPhase, ['implementation', 'input_preparation', 'service_runtime'] as const);
    for (const key of ['checkId', 'fingerprint', 'tree'] as const) {
      const text = optionalText(failure[key]); if (text) progress.lastFailure[key] = text;
    }
    if (failure.command !== undefined) {
      if (!Array.isArray(failure.command) || !failure.command.every((part): part is string => typeof part === 'string')) throw new Error('Invalid failed command');
      progress.lastFailure.command = failure.command;
    }
  }
  return progress;
}
export function metadataWithProgress(metadata: unknown, progress: ExecutionProgress): Prisma.InputJsonValue {
  return { ...record(metadata), progress } as unknown as Prisma.InputJsonValue;
}
export function immutableDispatchMetadata(metadata: unknown) {
  const { progress: _progress, ...dispatch } = record(metadata);
  return dispatch;
}
export function initialExecutionProgress(): ExecutionProgress {
  return { version: 1, revision: 0, phase: 'prepare', state: 'active', repairAttempts: 0, formatAttempts: 0, platformAttempts: 0, integrationAttempts: 0 };
}

/** Only this transaction advances versioned execution phases or spends retry budgets. */
export type ExecutionOutcomeRequest = {
  executionId: string; claimToken: string; expectedRevision: number; outcomeId: string; outcome: ExecutionOutcome;
};
export async function applyExecutionOutcome(args: ExecutionOutcomeRequest, db: Pick<typeof prisma, '$transaction'> = prisma): Promise<ExecutionProgress> {
  const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  const proof = before.taskRunId && !['checkpoint', 'integrated', 'waiting_for_user', 'decision_required', 'retry_exhausted', 'delivery_reclassified'].includes(args.outcome.kind)
    ? await observeTaskRunExit(before.taskRunId) : undefined;
  return db.$transaction(tx => applyExecutionOutcomeTx(tx, args, proof, before));
}
export async function applyExecutionOutcomeTx(tx: Prisma.TransactionClient, args: ExecutionOutcomeRequest, writerExit?: TaskRunExitProof, expectedExecution?: TaskGraphExecution): Promise<ExecutionProgress> {
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
    if (!['checkpoint', 'integrated', 'waiting_for_user'].includes(args.outcome.kind)) await requireGraphNodeActiveTx(tx, job.nodeId);
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id }, include: { node: true } });
    const idempotencyKey = `execution:${job.id}:outcome:${args.outcomeId}`;
    const repeated = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: current.node.runId, idempotencyKey } } });
    if (repeated) {
      const saved = record(repeated.payload);
      if (saved.claimToken !== args.claimToken || saved.expectedRevision !== args.expectedRevision || !isDeepStrictEqual(saved.outcome, args.outcome)) throw new Error('Conflicting execution outcome');
      const progress = executionProgress({ progress: saved.progress });
      if (!progress) throw new Error('Stored outcome has no progress');
      return progress;
    }
    const { node: _node, ...currentExecution } = current;
    if (expectedExecution && !isDeepStrictEqual(currentExecution, expectedExecution)) throw new Error('Execution outcome ownership or revision mismatch: observed candidate changed');
    const before = executionProgress(current.dispatchMetadata) || initialExecutionProgress();
    const operatorResume = args.outcome.kind === 'operator_resume' && current.status === 'attention' &&
      (before.state === 'waiting_decision' || before.state === 'waiting_for_user' && before.phase === 'implement');
    const reclassification = args.outcome.kind === 'delivery_reclassified' && current.status === 'integrated' && current.node.status === 'delivered_unverified';
    const reviewRepair = current.status === 'integrated' && ['repair_required', 'retry_exhausted', 'review_retry', 'decision_required'].includes(args.outcome.kind) && ['architecture', 'acceptance'].includes(before.phase);
    const reviewResume = args.outcome.kind === 'review_resumed' && current.node.status === 'attention' && ['architecture', 'acceptance'].includes(before.phase) && (
      current.status === 'attention' && before.state === 'waiting_decision' || current.status === 'integrated' && ['active', 'ready'].includes(before.state));
    const preparedReview = args.outcome.kind === 'review_platform_prepared' && current.status === 'attention' && before.state === 'exhausted' && before.platformAttempts >= executionRetryLimits.platformAttempts && before.lastFailure?.code === 'review_platform_failure' && before.phase === 'acceptance' && before.lastFailure.requiresUserDecision !== true && (!before.lastFailure.owner || before.lastFailure.owner === 'platform');
    if (args.outcome.kind === 'review_platform_prepared') {
      const receipt = await tx.taskGraphEvent.findUnique({ where: { id: args.outcome.preparationEventId } });
      const binding = record(receipt?.payload);
      if (!preparedReview || !receipt || receipt.kind !== 'platform_review_preparation' || receipt.nodeId !== current.nodeId || receipt.runId !== current.node.runId ||
          binding.executionId !== current.id || binding.claimToken !== current.claimToken || binding.expectedRevision !== before.revision || binding.candidateCommit !== current.commit || !current.commit) throw new Error('Prepared review authority or current candidate mismatch');
    }
    const conflictRecovery = current.status === 'attention' && before.state === 'waiting_decision' && before.lastFailure?.code === 'integration_conflict' &&
      (args.outcome.kind === 'repair_required' && !!args.outcome.conflictRepair || args.outcome.kind === 'decision_required' && args.outcome.failure.code === 'integration_conflict');
    if ((!preparedReview && !conflictRecovery && !reviewResume && !reviewRepair && !operatorResume && !reclassification && current.status !== 'claimed') || current.claimToken !== args.claimToken || before.revision !== args.expectedRevision) throw new Error('Execution outcome ownership or revision mismatch');
    if (args.outcome.kind === 'operator_resume' && (!operatorResume || !args.outcome.requestId.trim()) ||
        args.outcome.kind === 'delivery_reclassified' && (!reclassification || !args.outcome.authorization.trim())) throw new Error('Operator outcome is not authorized for the current state');
    if ((args.outcome.kind === 'integrated' || args.outcome.kind === 'integration_stale') && before.phase !== 'integrate' ||
        args.outcome.kind === 'repair_required' && !['check', 'integrate', 'architecture', 'acceptance'].includes(before.phase) ||
        args.outcome.kind === 'result_incomplete' && !['implement', 'collect_result', 'check'].includes(before.phase)) throw new Error('Execution outcome does not belong to current phase');
    const progress: ExecutionProgress = { ...before, revision: before.revision + 1, state: 'active' };
    delete progress.nextRetryAt;
    const outcome = args.outcome;
    let status = current.status;
    let issueKind: string | null = null;
    if (outcome.kind === 'continue_work') {
      if (!['implement', 'collect_result'].includes(before.phase) || !/^[a-f0-9]{64}$/.test(outcome.fingerprint) || !outcome.note.trim()) throw new Error('Invalid normal work continuation');
      const unchangedTurns = before.continuation?.fingerprint === outcome.fingerprint ? before.continuation.unchangedTurns + 1 : 0;
      progress.continuation = { fingerprint: outcome.fingerprint, unchangedTurns };
      progress.phase = 'implement';
      delete progress.lastFailure; delete progress.waitingKind; delete progress.waitingMessage;
      if (unchangedTurns >= maxUnchangedWorkTurns) {
        status = 'attention'; progress.state = 'waiting_for_user'; progress.waitingKind = 'answered';
        progress.waitingMessage = '连续轮次未产生新的代码、资料或用户输入，已停止空转并保留原会话。';
      } else { status = 'ready'; progress.state = 'ready'; }
    } else if (outcome.kind === 'waiting_for_user') {
      if (!['implement', 'collect_result'].includes(before.phase)) throw new Error('Only implementation turns may wait for user input');
      status = 'attention'; progress.state = 'waiting_for_user'; progress.waitingMessage = outcome.note; progress.waitingKind = outcome.result || 'question';
    } else if (outcome.kind === 'operator_resume') {
      if (before.lastFailure?.code === 'integration_conflict') throw new Error('Pending merge requires a bounded conflict repair decision; ordinary resume cannot restart implementation');
      status = 'ready'; progress.phase = before.conflictRepair ? 'integrate'
        : before.lastFailure?.owner === 'platform' && before.lastFailure.blockedPhase === 'input_preparation' && ['check', 'integrate'].includes(before.phase) ? before.phase : 'implement';
      progress.state = 'ready'; delete progress.review;
    } else if (outcome.kind === 'delivery_reclassified') {
      status = 'attention'; issueKind = outcome.failure.code; progress.phase = 'implement'; progress.state = 'waiting_decision';
      progress.lastFailure = outcome.failure; delete progress.review;
    } else if (outcome.kind === 'checkpoint') {
      progress.phase = outcome.phase;
      if (outcome.worker) { progress.worker = outcome.worker; delete progress.workerReleasedAt; }
      if (outcome.workspaceBase) progress.workspaceBase = outcome.workspaceBase;
      if (outcome.candidateCommit) {
        if (!/^[0-9a-f]{40,64}$/.test(outcome.candidateCommit)) throw new Error('Invalid candidate commit');
        progress.candidateCommit = outcome.candidateCommit;
      }
      if (outcome.runtimeDirectory) progress.runtimeDirectory = outcome.runtimeDirectory;
      if (outcome.conflictRepair === null) delete progress.conflictRepair;
      else if (outcome.conflictRepair) progress.conflictRepair = outcome.conflictRepair;
      if (outcome.conflictRepair === null) delete progress.runtimeDirectory;
    } else if (outcome.kind === 'integrated') {
      if (!/^[0-9a-f]{40,64}$/.test(outcome.commit) || !current.worktreePath || !current.worktreeBranch) throw new Error('Missing integration identity');
      status = 'integrated'; progress.phase = 'architecture'; progress.candidateCommit = outcome.commit;
    } else if (outcome.kind === 'integration_stale') {
      progress.integrationAttempts++;
      progress.lastFailure = outcome.failure;
      if (progress.integrationAttempts >= executionRetryLimits.integrationAttempts) {
        status = 'attention'; issueKind = 'retry_exhausted'; progress.state = 'exhausted';
      }
    } else if (outcome.kind === 'review_platform_prepared') {
      status = 'integrated'; progress.state = 'ready';
      progress.review = { kind: 'ready', candidateCommit: current.commit!, phase: before.phase === 'architecture' ? 'architecture' : 'acceptance', claimKey: `prepared-review:${outcome.preparationEventId}` };
    } else if (outcome.kind === 'review_resumed') {
      if (!reviewResume) throw new Error('Review has no authorized waiting decision');
      if (!current.commit || typeof outcome.claimKey !== 'string' || !outcome.claimKey.trim()) throw new Error('Review resume requires a fixed candidate and durable claim');
      status = 'integrated';
      progress.review = { kind: 'ready', phase: before.phase === 'architecture' ? 'architecture' : 'acceptance', claimKey: outcome.claimKey, candidateCommit: current.commit };
    } else if (outcome.kind === 'review_retry') {
      progress.lastFailure = outcome.failure;
      progress.phase = outcome.phase || before.phase;
      if (!['architecture', 'acceptance'].includes(before.phase)) throw new Error('Review retry is outside a review phase');
      if (progress.platformAttempts >= executionRetryLimits.platformAttempts) {
        status = 'attention'; issueKind = 'retry_exhausted'; progress.state = 'exhausted';
      } else {
        progress.platformAttempts++; progress.state = 'ready';
        if (!current.commit) throw new Error('Review restart has no integrated candidate');
        progress.review = { candidateCommit: current.commit, phase: progress.phase === 'architecture' ? 'architecture' : 'acceptance', claimKey: outcome.claimKey, kind: 'ready' };
      }
    } else if (outcome.kind === 'repair_required' && outcome.failure.tree && outcome.failure.fingerprint) {
      const recent = await tx.taskGraphEvent.findMany({ where: { runId: current.node.runId, nodeId: job.nodeId, kind: 'execution_outcome', AND: [
        { payload: { path: ['executionId'], equals: job.id } }, { payload: { path: ['outcome', 'kind'], equals: 'repair_required' } },
      ] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: maxUnchangedWorkTurns, select: { payload: true } });
      const stalled = recent.length === maxUnchangedWorkTurns && recent.every(event => {
        const previous = record(record(event.payload).outcome), failure = record(previous.failure);
        return failure.fingerprint === outcome.failure.fingerprint;
      });
      if (!stalled) progress.repairAttempts++;
      progress.phase = outcome.conflictRepair ? 'integrate' : 'implement'; progress.lastFailure = outcome.failure;
      if (outcome.conflictRepair) { progress.conflictRepair = outcome.conflictRepair; delete progress.runtimeDirectory; }
      if (stalled) {
        status = 'attention'; progress.state = 'waiting_for_user'; progress.waitingKind = 'answered';
        progress.waitingMessage = '相同代码与输入反复产生同一缺陷，已停止空转，原工作资格与现场保留。';
      } else { status = 'ready'; progress.state = 'ready'; }
    } else {
      progress.lastFailure = outcome.failure;
      if (outcome.kind === 'repair_required' && outcome.conflictRepair) { progress.conflictRepair = outcome.conflictRepair; delete progress.runtimeDirectory; }
      if (outcome.kind === 'decision_required') {
        status = 'attention'; issueKind = outcome.failure.code; progress.state = outcome.failure.code === 'ownership_mismatch' ? 'ownership_attention' : 'waiting_decision';
      } else {
        const budget = outcome.kind === 'result_incomplete' ? 'formatAttempts' : outcome.kind === 'platform_retry' ? 'platformAttempts' : 'repairAttempts';
        const limit = executionRetryLimits[budget];
        if (outcome.kind === 'retry_exhausted' || progress[budget] >= limit) {
          status = 'attention'; issueKind = 'retry_exhausted'; progress.state = 'exhausted';
        } else {
          progress[budget]++;
          progress.phase = outcome.kind === 'result_incomplete' ? 'collect_result' : outcome.kind === 'repair_required' ? outcome.conflictRepair ? 'integrate' : 'implement' : before.phase;
          progress.state = 'ready'; status = 'ready';
          if (outcome.kind === 'platform_retry') progress.nextRetryAt = new Date(Date.now() + 1000 * progress[budget]).toISOString();
        }
      }
    }
    if (status === 'ready' || outcome.kind === 'integrated' || outcome.kind === 'review_retry' || outcome.kind === 'review_platform_prepared') { delete progress.worker; delete progress.workerReleasedAt; }
    if (status === 'ready' && current.taskRunId && await tx.taskRun.count({ where: { id: current.taskRunId, status: { in: ['pending', 'running', 'waiting_for_input'] } } })) throw new Error('Cannot requeue a live TaskRun');
    if (status === 'ready' && current.taskRunId && outcome.kind !== 'operator_resume' && !await taskRunExitMatches(tx, current.taskRunId, writerExit)) throw new Error('Cannot requeue a TaskRun without actual writer exit proof');
    await tx.taskGraphExecution.update({ where: { id: current.id }, data: {
      status, issueKind, dispatchMetadata: metadataWithProgress(current.dispatchMetadata, progress),
      ...(status === 'ready' ? { claimToken: null, claimedAt: null, taskRunId: null, sessionId: null } : {}),
      ...(outcome.kind === 'integrated' ? { commit: outcome.commit, evidence: outcome.evidence } : {}),
    } });
    if (status === 'attention') await tx.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
    if (status === 'ready') {
      await tx.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'claimed' } });
      await tx.taskGraphRun.updateMany({ where: { id: current.node.runId, status: { not: 'paused' } }, data: { status: 'running' } });
    }
    if (outcome.kind === 'decision_required' && ['missing_business_material', 'missing_upstream_input', 'environment_failed', 'scope_change', 'permission_required'].includes(outcome.failure.code)) {
      await tx.taskGraphEvent.create({ data: { runId: current.node.runId, nodeId: job.nodeId,
        idempotencyKey: `${idempotencyKey}:blocked`, kind: 'implementation_blocked',
        payload: { recoveryKind: 'implementation', blockedPhase: outcome.failure.blockedPhase || progress.phase, executionId: job.id,
          checkpointCommit: progress.candidateCommit, workspaceBase: progress.workspaceBase,
          taskRunId: current.taskRunId, claimToken: args.claimToken,
          result: { status: 'blocked', blockerKind: outcome.failure.code, note: outcome.failure.detail } },
      } });
    }
    await tx.taskGraphEvent.create({ data: { runId: current.node.runId, nodeId: job.nodeId, idempotencyKey,
      kind: outcome.kind === 'integrated' ? 'execution_integrated' : 'execution_outcome',
      payload: { ...(outcome.kind === 'integrated' ? { commit: outcome.commit } : {}), executionId: job.id, claimToken: args.claimToken, expectedRevision: args.expectedRevision, outcome, progress } as unknown as Prisma.InputJsonValue,
    } });
    return progress;
}

/** Called in the same transaction that creates the TaskRun, before any process starts. */
export async function bindExecutionTaskRun(tx: Prisma.TransactionClient, args: { executionId: string; claimToken: string; revision: number }, taskRunId: string) {
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  await requireGraphNodeActiveTx(tx, job.nodeId);
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
  const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
  const progress = executionProgress(current.dispatchMetadata);
  if (!progress || progress.revision !== args.revision || current.status !== 'claimed' || current.claimToken !== args.claimToken || current.taskRunId) throw new Error('TaskRun execution binding is stale or occupied');
  await tx.taskGraphExecution.update({ where: { id: job.id }, data: {
    taskRunId, dispatchMetadata: metadataWithProgress(current.dispatchMetadata, { ...progress, taskRunId, conversationOwnerRunId: taskRunId }),
  } });
}

/** Fence actual filesystem work as well as database outcomes. */
export async function assertExecutionOwnership(executionId: string, claimToken: string, revision?: number) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
  const progress = executionProgress(job.dispatchMetadata);
  if (job.status !== 'claimed' || job.claimToken !== claimToken || (revision !== undefined && progress?.revision !== revision)) throw new Error('Execution ownership changed before Git operation');
  return job;
}
