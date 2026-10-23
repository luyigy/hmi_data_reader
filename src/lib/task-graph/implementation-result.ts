import { classifyReview, type ClassifiedReview, type ReviewCheck } from './review-contract';
import { continuationWorkFingerprint } from './continuation-work';
import { applyExecutionOutcome, executionProgress } from './execution-progress';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type ImplementationResult =
  | { status: 'delivered'; note: string; evidence: string[]; ticketVerification?: ClassifiedReview }
  | { status: 'waiting_for_user'; note: string }
  | { status: 'answered'; note: string }
  | { status: 'working'; note: string }
  | { status: 'blocked'; note: string; blockerKind: 'missing_business_material' | 'missing_upstream_input' | 'environment_failed' | 'scope_change' | 'permission_required'; blockerCause?: 'missing_capability' | 'transient' };
export type RecoveryKind = 'implementation' | 'verification';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Harness completion is transport success, never a delivery decision. */
export function parseImplementationResult(output: string, options?: { conversation?: boolean; reviewChecks?: ReviewCheck[] }): ImplementationResult {
  try { return decodeImplementationResult(output, options?.reviewChecks); }
  catch (error) {
    if (options?.conversation && output.trim() && !/^[ \t]*TASK_GRAPH_IMPLEMENTATION\b/m.test(output)) return { status: 'working', note: output.trim() };
    throw error;
  }
}

function decodeImplementationResult(output: string, checks: ReviewCheck[] = []): ImplementationResult {
  const matches = Array.from(output.matchAll(/^TASK_GRAPH_IMPLEMENTATION[ \t]+(\{[^\r\n]+\})[ \t]*$/gm));
  if (matches.length !== 1) throw new Error('实施缺少唯一的 TASK_GRAPH_IMPLEMENTATION 结论，不自动交付');
  let value: unknown;
  try { value = JSON.parse(matches[0][1]); }
  catch { throw new Error('实施结论 JSON 格式无效'); }
  if (!isRecord(value) || typeof value.note !== 'string' || !value.note.trim()) throw new Error('实施结论缺少有效说明');
  const note = value.note.trim();
  if (value.status === 'waiting_for_user' || value.status === 'answered' || value.status === 'working') return { status: value.status, note };
  if (value.status === 'delivered' && Array.isArray(value.evidence) && value.evidence.length &&
      value.evidence.every(item => typeof item === 'string' && item.trim())) {
    const decision = value.ticketVerification === undefined ? undefined : classifyReview(value.ticketVerification, checks);
    if (decision === null) throw new Error('ticketVerification 缺少有效的正式验收结论或缺陷归属');
    return { status: 'delivered', note, evidence: value.evidence, ...(decision ? { ticketVerification: decision } : {}) };
  }
  const kind = value.blockerKind;
  const cause = value.blockerCause;
  if (cause !== undefined && (kind !== 'environment_failed' || cause !== 'missing_capability' && cause !== 'transient')) throw new Error('实施阻塞原因无效');
  if (value.status === 'blocked' && (kind === 'missing_business_material' || kind === 'missing_upstream_input' ||
      kind === 'environment_failed' || kind === 'scope_change' || kind === 'permission_required')) {
    return { status: 'blocked', note, blockerKind: kind, ...(cause ? { blockerCause: cause } : {}) };
  }
  if (value.status === 'blocked') throw new Error('实施阻塞结论缺少有效 blockerKind：须为 missing_business_material、missing_upstream_input、environment_failed、scope_change 或 permission_required');
  if (value.status === 'delivered') throw new Error('实施交付结论缺少有效 evidence 证据：须为非空字符串数组');
  throw new Error('实施结论无效：status 须为 delivered、working、waiting_for_user、answered 或 blocked');
}

export async function pauseGraphImplementation(args: {
  runId: string; nodeKey: string; executionId: string; claimToken: string;
  checkpointCommit: string; workspaceBase: string; taskRunId: string; blockedPhase?: 'implementation' | 'input_preparation' | 'service_runtime';
  result: Extract<ImplementationResult, { status: 'blocked' }> | { status: 'invalid'; note: string; blockerKind: 'invalid_result' };
}) {
  const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  let progress = executionProgress(current.dispatchMetadata);
  if (progress && (progress.candidateCommit !== args.checkpointCommit || !progress.workspaceBase)) {
    progress = await applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
      expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:paused-candidate`,
      outcome: { kind: 'checkpoint', phase: progress.phase, candidateCommit: args.checkpointCommit, workspaceBase: progress.workspaceBase || args.workspaceBase },
    });
  }
  if (progress && progress.phase === 'implement' && (args.blockedPhase || 'implementation') === 'implementation') return applyExecutionOutcome({
    executionId: args.executionId, claimToken: args.claimToken, expectedRevision: progress.revision,
    outcomeId: `${args.claimToken}:${progress.revision}:engineering-work`,
    outcome: ['permission_required', 'scope_change'].includes(args.result.blockerKind)
      ? { kind: 'waiting_for_user', note: args.result.note, failure: { code: args.result.blockerKind, detail: args.result.note, blockedPhase: 'implementation', owner: 'user', requiresUserDecision: true } }
      : { kind: 'continue_work', note: args.result.note, fingerprint: await continuationWorkFingerprint(args.executionId, args.checkpointCommit) },
  });
  if (progress) return applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:decision_required`,
    outcome: { kind: args.result.blockerKind === 'environment_failed' && args.result.status === 'blocked' && args.result.blockerCause === 'transient' ? 'platform_retry' : 'decision_required',
      failure: { code: args.result.blockerKind, detail: args.result.note, blockedPhase: args.blockedPhase || 'implementation',
        ...(args.result.status === 'blocked' && args.result.blockerCause ? { blockerCause: args.result.blockerCause } : {}),
        ...(['permission_required', 'scope_change'].includes(args.result.blockerKind) ? { owner: 'user' as const, requiresUserDecision: true } : {}),
        ...(['environment_failed', 'missing_upstream_input'].includes(args.result.blockerKind) ? { owner: 'platform' as const, requiresUserDecision: false,
          action: args.result.status === 'blocked' && args.result.blockerCause === 'transient' ? '按已有预算重试暂时平台故障' : '准备并验证缺少的运行能力后从已保存候选继续；环境不变时不重复实施' } : {}) } },
  });
  return prisma.$transaction(async tx => {
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } });
    if (node.runId !== args.runId || node.key !== args.nodeKey) throw new Error('Implementation target mismatch');
    if (job.status !== 'claimed' || job.claimToken !== args.claimToken) throw new Error('Implementation claim mismatch');
    await tx.taskGraphEvent.create({ data: { runId: args.runId, nodeId: job.nodeId,
      idempotencyKey: `execution:${job.id}:implementation:${args.claimToken}`, kind: 'implementation_blocked',
      payload: { recoveryKind: 'implementation', blockedPhase: args.blockedPhase || 'implementation', executionId: job.id,
        checkpointCommit: args.checkpointCommit, workspaceBase: args.workspaceBase, taskRunId: args.taskRunId,
        claimToken: args.claimToken, result: args.result } } });
    await tx.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention', issueKind: args.result.blockerKind } });
    await tx.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
  });
}

export async function graphRecoveryKind(nodeId: string): Promise<RecoveryKind> {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId } });
  const current = jobs.map(job => executionProgress(job.dispatchMetadata)).filter(value => value !== null);
  if (current.length) return current.some(value => !['architecture', 'acceptance'].includes(value.phase)) ? 'implementation' : 'verification';
  const event = await prisma.taskGraphEvent.findFirst({ where: { nodeId,
    kind: { in: ['implementation_blocked', 'node_delivery_reclassified', 'implementation_recovery_scheduled',
      'verification_failed', 'review_workspace_failed', 'architecture_failed', 'human_review_rejected', 'node_repair_scheduled'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return isRecord(event?.payload) && event.payload.recoveryKind === 'implementation' ? 'implementation' : 'verification';
}

export async function latestImplementationRecovery(nodeId: string) {
  return prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: 'implementation_recovery_scheduled' }, orderBy: { createdAt: 'desc' } });
}

export function implementationCheckpoint(payload: unknown, executionId: string) {
  if (!isRecord(payload) || !Array.isArray(payload.executions)) return null;
  const item = payload.executions.find(value => isRecord(value) && value.id === executionId);
  if (!isRecord(item) || typeof item.checkpointCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(item.checkpointCommit) ||
      typeof item.workspaceBase !== 'string' || !/^[0-9a-f]{40,64}$/.test(item.workspaceBase)) return null;
  return { checkpointCommit: item.checkpointCommit, workspaceBase: item.workspaceBase };
}

/** Trusted server callers retain their authenticated request; admission owns all state changes. */
export async function scheduleImplementationRecovery(runId: string, nodeKey: string, requestId: string, preparedEventId?: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  const { admitNode, AdmissionRefused } = await import('./preparation-recovery');
  const result = await admitNode(node.id, { source: 'operator', id: requestId, ...(preparedEventId ? { preparedEventId } : {}) });
  if (result.kind === 'admitted') return { kind: 'scheduled' as const, eventId: result.eventId };
  if (result.kind === 'already_scheduled') return result;
  throw new AdmissionRefused(result);
}
