import { assertExecutionWriterExited } from './phase-worker';
import { applyExecutionOutcome, applyExecutionOutcomeTx, executionProgress } from './execution-progress';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { assertPreparationTx } from './preparation-contract';

export type ImplementationResult =
  | { status: 'delivered'; note: string; evidence: string[] }
  | { status: 'waiting_for_user'; note: string }
  | { status: 'answered'; note: string }
  | { status: 'blocked'; note: string; blockerKind: 'missing_business_material' | 'missing_upstream_input' | 'environment_failed' | 'scope_change' | 'permission_required'; blockerCause?: 'missing_capability' | 'transient' };
export type RecoveryKind = 'implementation' | 'verification';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Harness completion is transport success, never a delivery decision. */
export function parseImplementationResult(output: string, options?: { conversation: boolean }): ImplementationResult {
  if (options?.conversation && output.trim() && !output.includes('TASK_GRAPH_IMPLEMENTATION')) return { status: 'answered', note: output.trim() };
  const matches = Array.from(output.matchAll(/^TASK_GRAPH_IMPLEMENTATION[ \t]+(\{[^\r\n]+\})[ \t]*$/gm));
  if (matches.length !== 1) throw new Error('实施缺少唯一的 TASK_GRAPH_IMPLEMENTATION 结论，不自动交付');
  const value: unknown = JSON.parse(matches[0][1]);
  if (!isRecord(value) || typeof value.note !== 'string' || !value.note.trim()) throw new Error('实施结论缺少有效说明');
  const note = value.note.trim();
  if (value.status === 'waiting_for_user' || value.status === 'answered') return { status: value.status, note };
  if (value.status === 'delivered' && Array.isArray(value.evidence) && value.evidence.length &&
      value.evidence.every(item => typeof item === 'string' && item.trim())) {
    return { status: 'delivered', note, evidence: value.evidence };
  }
  const kind = value.blockerKind;
  const cause = value.blockerCause;
  if (cause !== undefined && (kind !== 'environment_failed' || cause !== 'missing_capability' && cause !== 'transient')) throw new Error('实施阻塞原因无效');
  if (value.status === 'blocked' && (kind === 'missing_business_material' || kind === 'missing_upstream_input' ||
      kind === 'environment_failed' || kind === 'scope_change' || kind === 'permission_required')) {
    return { status: 'blocked', note, blockerKind: kind, ...(cause ? { blockerCause: cause } : {}) };
  }
  throw new Error('实施结论无效：交付须有证据，阻塞须有明确类别');
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
  if (progress && progress.phase === 'implement' && (args.blockedPhase || 'implementation') === 'implementation' && args.result.blockerKind === 'missing_business_material') return applyExecutionOutcome({
    executionId: args.executionId, claimToken: args.claimToken, expectedRevision: progress.revision,
    outcomeId: `${args.claimToken}:${progress.revision}:material-question`, outcome: { kind: 'waiting_for_user', note: args.result.note },
  });
  if (progress) return applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:decision_required`,
    outcome: { kind: args.result.blockerKind === 'environment_failed' && args.result.status === 'blocked' && args.result.blockerCause === 'transient' ? 'platform_retry' : 'decision_required',
      failure: { code: args.result.blockerKind, detail: args.result.note, blockedPhase: args.blockedPhase || 'implementation',
        ...(args.result.status === 'blocked' && args.result.blockerCause ? { blockerCause: args.result.blockerCause } : {}),
        ...(args.result.blockerKind === 'environment_failed' ? { owner: 'platform' as const, requiresUserDecision: false,
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

/** Requeue through the existing claims, preserving the previous attempt in an append-only event. */
export async function scheduleImplementationRecovery(runId: string, nodeKey: string, requestId: string, preparedEventId?: string) {
  return prisma.$transaction(async tx => {
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
    const key = `node:${nodeKey}:implementation-recovery:${requestId}`;
    const previousRequest = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } });
    if (previousRequest) return { kind: 'already_scheduled' as const, eventId: previousRequest.id };
    let preparation: Awaited<ReturnType<typeof assertPreparationTx>> | undefined;
    if (preparedEventId) {
      if (requestId !== `prepared:${preparedEventId}`) throw new Error('Preparation request identity mismatch');
      preparation = await assertPreparationTx(tx, runId, nodeKey, preparedEventId);
    }
    if (current.status !== 'attention' || current.executions.some(job => job.status === 'claimed')) throw new Error('实施仍在执行或状态已改变');
    if (await tx.taskRun.count({ where: { taskId: { in: [...current.executions.flatMap(job => job.childTaskId ? [job.childTaskId] : []),
      `task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['pending', 'running'] } } })) throw new Error('原任务进程仍在执行，请等待结束');
    for (const job of current.executions) {
      if (job.status !== 'integrated' && executionProgress(job.dispatchMetadata)?.state === 'waiting_decision') await assertExecutionWriterExited(tx, job);
      if (job.status !== 'integrated' && job.worktreePath && !executionProgress(job.dispatchMetadata)?.conflictRepair &&
          await graphGit(job.worktreePath, 'rev-parse', '--verify', 'MERGE_HEAD').then(() => true, () => false)) {
        throw new Error('待完成合并尚无受控冲突修复方案；平台须先核验来源和文件范围，普通继续不能重新实施');
      }
    }
    const blocks = await tx.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: { in: ['implementation_blocked', 'node_delivery_reclassified'] } }, orderBy: { createdAt: 'desc' } });
    const executions = current.executions.flatMap(job => {
      const progress = executionProgress(job.dispatchMetadata);
      if (progress?.state === 'exhausted') throw new Error('自动处理预算已耗尽，普通继续不能重置预算；请明确新的修复措施或授权');
      if (progress?.state === 'ownership_attention') throw new Error('执行归属尚未核对，普通继续不能重新放行写入；须先完成归属核对');
      if (progress) {
        if (job.status === 'integrated') return [];
        if (progress.state !== 'waiting_decision') throw new Error('当前执行不是等待人工决定的实施暂停');
        if (!progress.candidateCommit || !progress.workspaceBase) throw new Error('缺少当前候选提交或原始基线');
        return [{ id: job.id, key: job.key, checkpointCommit: progress.candidateCommit, workspaceBase: progress.workspaceBase,
          previousTaskRunId: job.taskRunId, previousSessionId: job.sessionId, previousCommit: job.commit,
          previousDispatch: job.dispatchMetadata, previousEvidence: job.evidence }];
      }
      const event = blocks.find(block => isRecord(block.payload) && block.payload.executionId === job.id);
      const payload = event?.payload;
      if (job.status === 'integrated' && !(event?.kind === 'node_delivery_reclassified' && isRecord(payload) && payload.taskRunId === job.taskRunId)) return [];
      if (!isRecord(payload) || typeof payload.checkpointCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(payload.checkpointCommit) ||
          typeof payload.workspaceBase !== 'string' || !/^[0-9a-f]{40,64}$/.test(payload.workspaceBase)) throw new Error('缺少已核验的实施保存点，保留现场');
      return [{ id: job.id, key: job.key, checkpointCommit: payload.checkpointCommit, workspaceBase: payload.workspaceBase,
        previousTaskRunId: job.taskRunId, previousSessionId: job.sessionId, previousCommit: job.commit,
        previousDispatch: job.dispatchMetadata, previousEvidence: job.evidence }];
    });
    if (!executions.length) throw new Error('没有可恢复的实施保存点');
    const event = await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: key, kind: 'implementation_recovery_scheduled',
      payload: { recoveryKind: 'implementation', blockedPhase: 'implementation', requestId, executions,
        ...(preparation ? { preparation: { eventId: preparedEventId, ...preparation, inputPolicy: 'Supplementary reviewed preparation only; frozen upstream commits and acceptance contract remain authoritative' } } : {}) } } });
    for (const saved of executions) {
      const job = current.executions.find(item => item.id === saved.id)!;
      const progress = executionProgress(job.dispatchMetadata);
      if (progress) {
        if (!job.claimToken) throw new Error('缺少原执行归属');
        await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
          outcomeId: `operator-resume:${requestId}`, outcome: { kind: 'operator_resume', requestId } });
      } else await tx.taskGraphExecution.update({ where: { id: job.id }, data: {
        status: 'ready', claimToken: null, claimedAt: null, issueKind: null, taskRunId: null, sessionId: null,
        dispatchMetadata: Prisma.DbNull,
      } });
    }
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'ready', passedAt: null, claimToken: null, claimedAt: null } });
    await tx.taskGraphRun.update({ where: { id: runId }, data: { status: 'running' } });
    return { kind: 'scheduled' as const, eventId: event.id };
  });
}
