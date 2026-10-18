import { applyExecutionOutcome, executionProgress, metadataWithProgress } from './execution-progress';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type ImplementationResult =
  | { status: 'delivered'; note: string; evidence: string[] }
  | { status: 'blocked'; note: string; blockerKind: 'missing_business_material' | 'missing_upstream_input' | 'environment_failed' | 'scope_change' | 'permission_required' };
export type RecoveryKind = 'implementation' | 'verification';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Harness completion is transport success, never a delivery decision. */
export function parseImplementationResult(output: string): ImplementationResult {
  const matches = Array.from(output.matchAll(/^TASK_GRAPH_IMPLEMENTATION[ \t]+(\{[^\r\n]+\})[ \t]*$/gm));
  if (matches.length !== 1) throw new Error('实施缺少唯一的 TASK_GRAPH_IMPLEMENTATION 结论，不自动交付');
  const value: unknown = JSON.parse(matches[0][1]);
  if (!isRecord(value) || typeof value.note !== 'string' || !value.note.trim()) throw new Error('实施结论缺少有效说明');
  const note = value.note.trim();
  if (value.status === 'delivered' && Array.isArray(value.evidence) && value.evidence.length &&
      value.evidence.every(item => typeof item === 'string' && item.trim())) {
    return { status: 'delivered', note, evidence: value.evidence };
  }
  const kind = value.blockerKind;
  if (value.status === 'blocked' && (kind === 'missing_business_material' || kind === 'missing_upstream_input' ||
      kind === 'environment_failed' || kind === 'scope_change' || kind === 'permission_required')) {
    return { status: 'blocked', note, blockerKind: kind };
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
  if (progress && (progress.candidateCommit !== args.checkpointCommit || progress.workspaceBase !== args.workspaceBase)) {
    progress = await applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
      expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:paused-candidate`,
      outcome: { kind: 'checkpoint', phase: progress.phase, candidateCommit: args.checkpointCommit, workspaceBase: args.workspaceBase },
    });
  }
  if (progress) return applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:decision_required`,
    outcome: { kind: args.result.blockerKind === 'environment_failed' ? 'platform_retry' : 'decision_required', failure: { code: args.result.blockerKind, detail: args.result.note } },
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
export async function scheduleImplementationRecovery(runId: string, nodeKey: string, requestId: string) {
  return prisma.$transaction(async tx => {
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
    const key = `node:${nodeKey}:implementation-recovery:${requestId}`;
    if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } })) return;
    if (current.status !== 'attention' || current.executions.some(job => job.status === 'claimed')) throw new Error('实施仍在执行或状态已改变');
    if (await tx.taskRun.count({ where: { taskId: { in: [...current.executions.flatMap(job => job.childTaskId ? [job.childTaskId] : []),
      `task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['pending', 'running'] } } })) throw new Error('原任务进程仍在执行，请等待结束');
    const blocks = await tx.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: { in: ['implementation_blocked', 'node_delivery_reclassified'] } }, orderBy: { createdAt: 'desc' } });
    const executions = current.executions.flatMap(job => {
      const progress = executionProgress(job.dispatchMetadata);
      if (progress?.state === 'exhausted') throw new Error('自动处理预算已耗尽，普通继续不能重置预算；请明确新的修复措施或授权');
      if (progress?.state === 'ownership_attention') throw new Error('执行归属尚未核对，普通继续不能重新放行写入；须先完成归属核对');
      if (progress && job.status !== 'integrated') {
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
    await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: key, kind: 'implementation_recovery_scheduled',
      payload: { recoveryKind: 'implementation', blockedPhase: 'implementation', requestId, executions } } });
    for (const saved of executions) {
      const job = current.executions.find(item => item.id === saved.id)!;
      const progress = executionProgress(job.dispatchMetadata);
      await tx.taskGraphExecution.update({ where: { id: job.id }, data: {
        status: 'ready', claimToken: null, claimedAt: null, issueKind: null, taskRunId: null, sessionId: null,
        dispatchMetadata: progress ? metadataWithProgress(job.dispatchMetadata, { ...progress, revision: progress.revision + 1, phase: 'implement', state: 'ready' }) : Prisma.DbNull,
      } });
    }
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'ready', passedAt: null, claimToken: null, claimedAt: null } });
    await tx.taskGraphRun.update({ where: { id: runId }, data: { status: 'running' } });
  });
}
