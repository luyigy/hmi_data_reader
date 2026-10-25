import { assertCandidateInputsIntegrated } from './candidate-integration';
import { implementationQuality } from './implementation-quality';
import { graphRunCanStartTx, graphRunBusinessStatus } from './run-control';
import { observeGraphWriter, type GraphWriter } from './writer-ownership';
import { observeTaskRunExit, taskRunExitMatches } from './task-run-exit-proof';
import { applyReviewFailureTx, type ReviewPublication } from './review-publication';
import { assertGraphReviewOwnershipTx } from './review-ownership';
import { createHash } from 'node:crypto';
import { executionProgress, immutableDispatchMetadata, initialExecutionProgress, metadataWithProgress, applyExecutionOutcome, applyExecutionOutcomeTx } from './execution-progress';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { effectiveArchitectureReview, verificationInputs, isCompletedNodeStatus, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';

type Database = PrismaClient;

function required(value: string, label: string) {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

/** Persist one confirmed version. requestKey makes launch retries return the same run. */
export async function createTaskGraphRun(
  args: { parentTaskId: string; version: number; requestKey: string; definition: GraphDefinition },
  db: Database = prisma,
) {
  required(args.parentTaskId, 'parentTaskId');
  required(args.requestKey, 'requestKey');
  if (!Number.isInteger(args.version) || args.version < 1) throw new Error('version must be a positive integer');
  const definition = validateTaskGraphDefinition(args.definition);
  if (definition.adoptRun) throw new Error('Existing run association must not create a second task graph');
  const snapshotHash = taskGraphSnapshotHash(definition);
  const create = () => db.$transaction(async (tx) => {
    const existing = await tx.taskGraphRun.findUnique({ where: { requestKey: args.requestKey } });
    if (existing) {
      if (existing.parentTaskId !== args.parentTaskId || existing.version !== args.version ||
          existing.snapshotHash !== snapshotHash) throw new Error('Graph requestKey was reused with different content');
      return existing;
    }
    const run = await tx.taskGraphRun.create({
      data: {
        parentTaskId: args.parentTaskId, version: args.version, requestKey: args.requestKey,
        snapshotHash, snapshot: definition as unknown as Prisma.InputJsonValue,
        nodes: { create: definition.nodes.map((node) => ({
          key: node.key,
          dependsOn: node.dependsOn,
          acceptance: node.acceptance.mode,
          reviewerId: node.acceptance.reviewerId,
          executions: { create: node.executions.map((job) => ({
            key: job.key, repository: job.repository, gitRef: job.gitRef,
            baseCommit: job.baseCommit, agentSelector: job.agentSelector,
            launchConfig: job.launchConfig === undefined ? undefined : job.launchConfig as Prisma.InputJsonValue,
          })) },
        })) },
      },
    });
    await tx.taskGraphEvent.create({
      data: { runId: run.id, idempotencyKey: 'run:created', kind: 'run_created', payload: { snapshotHash } },
    });
    return run;
  });
  try {
    return await create();
  } catch (error) {
    // A concurrent launch with the same requestKey may win the unique index.
    const existing = await db.taskGraphRun.findUnique({ where: { requestKey: args.requestKey } });
    if (existing && existing.parentTaskId === args.parentTaskId && existing.version === args.version &&
        existing.snapshotHash === snapshotHash) return existing;
    throw error;
  }
}

/** Rebuild the frontier after a restart. Only accepted predecessor slices count. */
export async function releaseReadyNodes(runId: string, db: Database = prisma): Promise<string[]> {
  required(runId, 'runId');
  return db.$transaction(async (tx) => {
    if (!await graphRunCanStartTx(tx, runId)) return [];
    const nodes = await tx.taskGraphNode.findMany({ where: { runId }, select: { id: true, key: true, dependsOn: true, status: true } });
    const passed = new Set(nodes.filter((node) => isCompletedNodeStatus(node.status)).map((node) => node.key));
    const released: string[] = [];
    for (const node of nodes) {
      if (node.status !== 'planned' || !node.dependsOn.every((key) => passed.has(key))) continue;
      const result = await tx.taskGraphNode.updateMany({ where: { id: node.id, status: 'planned' }, data: { status: 'ready' } });
      if (result.count !== 1) continue;
      await tx.taskGraphExecution.updateMany({ where: { nodeId: node.id, status: 'planned' }, data: { status: 'ready' } });
      await tx.taskGraphEvent.create({
        data: { runId, nodeId: node.id, idempotencyKey: `node:${node.key}:ready`, kind: 'node_ready', payload: {} },
      });
      released.push(node.key);
    }
    return released;
  });
}

/** compare-and-swap claim: a restarted worker can retry the same token safely. */
export async function claimNode(runId: string, nodeKey: string, claimToken: string, db: Database = prisma) {
  required(claimToken, 'claimToken');
  return db.$transaction(async (tx) => {
    if (!await graphRunCanStartTx(tx, runId)) return null;
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId, key: nodeKey } } });
    if (!node) throw new Error('Unknown graph node');
    if (node.status === 'claimed' && node.claimToken === claimToken) return node;
    const canonical = async (repository: string) => realpath(repository).catch(() => repository);
    const snapshot = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true } });
    const graph = snapshot.snapshot as unknown as GraphDefinition;
    const extra = (key: string) => graph.nodes.find(planned => planned.key === key)?.extraRepositories || [];
    const requested = extra(node.key);
    const scopes = await Promise.all(requested.map(async item => ({ ...item, repository: await canonical(item.repository) })));
    const roots = scopes.map(item => item.repository);
    for (const repository of Array.from(new Set(roots)).sort()) {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'task-graph-extra:' + repository}, 0))`;
      const blockers = await tx.taskGraphNode.findMany({ where: { id: { not: node.id },
        status: { in: ['claimed', 'verifying', 'awaiting_human', 'attention'] } },
        select: { id: true, key: true, run: { select: { snapshot: true } } } });
      const expanded = blockers.flatMap(blocker => {
        const approved = blocker.run.snapshot as unknown as GraphDefinition;
        return (approved.nodes.find(planned => planned.key === blocker.key)?.extraRepositories || [])
          .map(item => ({ ...item, node: blocker }));
      });
      const normalized = await Promise.all(expanded.map(async job => ({ ...job, repository: await canonical(job.repository) })));
      const blocker = normalized.find(job => job.repository === repository && (job.access === 'write' || scopes.some(item => item.repository === repository && item.access === 'write')));
      if (blocker) {
        await tx.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repository-wait:${blocker.node.key}`,
          kind: 'repository_gate_waiting', payload: { repository, blockedBy: blocker.node.key } }], skipDuplicates: true });
        return null;
      }
    }

    const updated = await tx.taskGraphNode.updateMany({
      where: { id: node.id, status: 'ready', claimToken: null },
      data: { status: 'claimed', claimToken, claimedAt: new Date() },
    });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:claimed:${claimToken}`, kind: 'node_claimed', payload: { claimToken } },
    });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
  });
}

export async function claimExecution(
  runId: string, nodeKey: string, executionKey: string, claimToken: string, db: Database = prisma, worker?: GraphWriter,
) {
  required(claimToken, 'claimToken');
  return db.$transaction(async (tx) => {
    if (!await graphRunCanStartTx(tx, runId)) return null;
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE "runId" = ${runId} AND "key" = ${nodeKey} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId, key: nodeKey } }, include: { run: true } });
    if (!node || node.status !== 'claimed') return null;
    const execution = await tx.taskGraphExecution.findUnique({ where: { nodeId_key: { nodeId: node.id, key: executionKey } } });
    if (!execution) throw new Error('Unknown graph execution');
    const progress = executionProgress(execution.dispatchMetadata);
    if (progress?.state === 'exhausted' || (progress?.nextRetryAt && Date.parse(progress.nextRetryAt) > Date.now())) return null;
    if (execution.status === 'claimed' && execution.claimToken === claimToken) return execution;
    if (progress?.worker && (await observeGraphWriter(progress.worker, Boolean(progress.workerReleasedAt))).kind !== 'exited') return null;
    const approved = node.run.snapshot as unknown as GraphDefinition;
    const sharedWriter = approved.nodes.find(planned => planned.key === node.key)?.extraRepositories?.some(extra => extra.access === 'write');
    if (sharedWriter && await tx.taskGraphExecution.count({ where: { nodeId: node.id, id: { not: execution.id }, status: 'claimed' } })) return null;
    const updated = await tx.taskGraphExecution.updateMany({
      where: { id: execution.id, status: 'ready', claimToken: null },
      data: { status: 'claimed', claimToken, claimedAt: new Date(), ...(worker ? { dispatchMetadata: metadataWithProgress(execution.dispatchMetadata, { ...(progress || initialExecutionProgress()), revision: (progress?.revision || 0) + 1, state: 'active', worker, workerReleasedAt: undefined, conversation: undefined }) } : {}) },
    });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `execution:${nodeKey}:${executionKey}:claimed:${claimToken}`,
        kind: 'execution_claimed', payload: { claimToken, ...(worker ? { worker } : {}) } },
    });
    return tx.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
  });
}

/** Bind the durable IDs before calling external systems again on restart. */
export async function recordExecutionDispatch(args: {
  runId: string; nodeKey: string; executionKey: string; claimToken: string;
  childTaskId?: string; sessionId?: string; taskRunId?: string;
  worktreePath?: string; worktreeBranch?: string; dispatchMetadata?: unknown;
}, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const execution = await tx.taskGraphExecution.findFirst({
      where: { key: args.executionKey, node: { runId: args.runId, key: args.nodeKey } },
    });
    if (!execution || execution.status !== 'claimed' || execution.claimToken !== args.claimToken) {
      throw new Error('Execution is not claimed by this worker');
    }
    for (const field of ['childTaskId', 'sessionId', 'taskRunId', 'worktreePath', 'worktreeBranch'] as const) {
      if (args[field] !== undefined && execution[field] !== null && execution[field] !== args[field]) {
        throw new Error(`Conflicting execution ${field}`);
      }
    }
    if (args.dispatchMetadata !== undefined && execution.dispatchMetadata !== null &&
        (execution.worktreePath !== null || Object.keys(immutableDispatchMetadata(execution.dispatchMetadata)).length > 0) &&
        !isDeepStrictEqual(immutableDispatchMetadata(execution.dispatchMetadata), immutableDispatchMetadata(args.dispatchMetadata))) {
      throw new Error('Conflicting execution dispatchMetadata');
    }
    return tx.taskGraphExecution.update({
      where: { id: execution.id },
      data: {
        childTaskId: args.childTaskId, sessionId: args.sessionId, taskRunId: args.taskRunId,
        worktreePath: args.worktreePath, worktreeBranch: args.worktreeBranch,
        dispatchMetadata: args.dispatchMetadata === undefined ? undefined : { ...immutableDispatchMetadata(args.dispatchMetadata), ...(executionProgress(execution.dispatchMetadata) ? { progress: executionProgress(execution.dispatchMetadata) } : {}) } as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

/** Called only after commit, merge and repository checks succeed. */
export async function completeExecution(args: {
  runId: string; nodeKey: string; executionKey: string; claimToken: string;
  commit: string; evidence: unknown;
}, db: Database = prisma) {
  if (!/^[0-9a-f]{40,64}$/i.test(args.commit)) throw new Error('Integrated commit is required');
  if (args.evidence === undefined || args.evidence === null) throw new Error('Integration evidence is required');
  return db.$transaction(async (tx) => {
    const execution = await tx.taskGraphExecution.findFirst({
      where: { key: args.executionKey, node: { runId: args.runId, key: args.nodeKey } },
    });
    if (!execution || execution.claimToken !== args.claimToken) throw new Error('Execution claim mismatch');
    if (execution.status === 'integrated') {
      if (execution.commit !== args.commit || JSON.stringify(execution.evidence) !== JSON.stringify(args.evidence)) {
        throw new Error('Conflicting integration result');
      }
      return execution;
    }
    if (execution.status !== 'claimed') throw new Error('Execution is not claimed');
    const progress = executionProgress(execution.dispatchMetadata);
    if (progress) {
      await applyExecutionOutcomeTx(tx, { executionId: execution.id, claimToken: args.claimToken, expectedRevision: progress.revision,
        outcomeId: `complete:${args.commit}`, outcome: { kind: 'integrated', commit: args.commit, evidence: args.evidence as Prisma.InputJsonValue } });
      return tx.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
    }
    if (!execution.worktreePath || !execution.worktreeBranch) throw new Error('Worktree evidence is required');
    const changed = await tx.taskGraphExecution.updateMany({
      where: { id: execution.id, status: 'claimed', claimToken: args.claimToken },
      data: { status: 'integrated', commit: args.commit, evidence: args.evidence as Prisma.InputJsonValue },
    });
    if (changed.count !== 1) throw new Error('Execution result changed concurrently');
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: execution.nodeId,
        idempotencyKey: `execution:${args.nodeKey}:${args.executionKey}:integrated:${args.commit}`,
        kind: 'execution_integrated', payload: { commit: args.commit } },
    });
    return tx.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
  });
}

/** No acceptance can begin while a repository execution is unfinished. */
export async function markNodeIntegrationsReady(runId: string, nodeKey: string, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE "runId" = ${runId} AND key = ${nodeKey} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUnique({
      where: { runId_key: { runId, key: nodeKey } }, include: { executions: true },
    });
    if (!node) throw new Error('Unknown graph node');
    if (node.status === 'verifying' || node.status === 'awaiting_human' || node.status === 'passed') return node;
    if (node.status !== 'claimed' || !node.executions.length || node.executions.some((job) => job.status !== 'integrated')) return null;
    const updated = await tx.taskGraphNode.updateMany({ where: { id: node.id, status: 'claimed' }, data: { status: 'verifying' } });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:verifying:${createHash('sha256').update(JSON.stringify(node.executions.map(job => [job.id, job.commit, executionProgress(job.dispatchMetadata)?.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex').slice(0, 24)}`, kind: 'node_verifying', payload: {} },
    });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
  });
}

export type VerificationEvidence = {
  checks: { name: string; passed: boolean; evidence: string }[];
  summary: string;
  inputs?: { executionId: string; commit: string | null }[];
};

/** An approved implement-only policy permits relay, while retaining the unverified result. */
export async function completeUnverifiedNode(runId: string, nodeKey: string, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true } });
    const definition = run.snapshot as unknown as GraphDefinition;
    if (definition.nodes.find((node) => node.key === nodeKey)?.executionMode !== 'implement') {
      throw new Error('Only an approved implement-only node may finish without verification');
    }
    const node = await tx.taskGraphNode.findUniqueOrThrow({
      where: { runId_key: { runId, key: nodeKey } }, include: { executions: true },
    });
    if (node.status === 'delivered_unverified') return node;
    if (node.status !== 'verifying' || node.executions.some((job) => job.status !== 'integrated')) {
      throw new Error('All executions must be integrated before unverified delivery');
    }
    await assertCandidateInputsIntegrated(tx, node.id);
    const changed = await tx.taskGraphNode.updateMany({ where: { id: node.id, status: 'verifying' },
      data: { status: 'delivered_unverified', evidence: { summary: '按已批准的仅实施模式交付；未执行独立架构审查或测试验收。' } } });
    if (changed.count === 1) await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id,
      idempotencyKey: `node:${nodeKey}:delivered_unverified:${node.claimToken}`, kind: 'delivered_unverified', payload: {} } });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
  });
}

/** Agent review requires the configured reviewer; human review creates a pause. */
export async function submitNodeVerification(args: {
  runId: string; nodeKey: string; actorId: string; evidence: VerificationEvidence; attempt?: string;
  review?: ReviewPublication;
}, db: Database = prisma) {
  const writerExit = args.review?.outcome === 'platform_failure' ? await observeTaskRunExit(args.review.taskRunId) : undefined;
  return db.$transaction(async (tx) => {
    // Match admission/reservation lock order; outcome handling retains the pause policy.
    await graphRunCanStartTx(tx, args.runId);
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE "runId" = ${args.runId} AND key = ${args.nodeKey} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId: args.runId, key: args.nodeKey } } });
    if (!node) throw new Error('Unknown graph node');
    const snapshot = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: args.runId }, select: { snapshot: true } });
    const definition = snapshot.snapshot as unknown as GraphDefinition;
    const planned = definition.nodes.find(item => item.key === args.nodeKey);
    if (!planned) throw new Error('Acceptance policy missing from snapshot');
    const agentOwned = definition.deliveryContract === 'agent_owned_v1';
    if (node.acceptance === 'agent' && node.reviewerId !== args.actorId) throw new Error('Wrong review agent');
    if (agentOwned) {
      if (node.acceptance !== 'agent' && args.actorId !== 'system') throw new Error('Wrong verification actor');
      const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      if (!jobs.length || jobs.some(job => job.status !== 'integrated' || !job.commit) || !isDeepStrictEqual(args.evidence.inputs, verificationInputs(jobs))) throw new Error('Verification input commits changed');
      if (node.acceptance !== 'agent') {
        const quality = implementationQuality(planned, jobs);
        if (!quality || args.evidence.checks.some(item => item.passed && !quality.decision.approved)) throw new Error('Approved implementor Ticket verification is missing or not passed');
      }
      if (Array.isArray(args.evidence?.checks) && args.evidence.checks.every(item => item.passed) && effectiveArchitectureReview(definition, planned)) {
        const architecture = await tx.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'architecture_passed' }, orderBy: { createdAt: 'desc' } });
        const payload = architecture?.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isDeepStrictEqual(payload.inputs, verificationInputs(jobs))) throw new Error('Architecture result does not match fixed inputs');
      }
    }
    if (['passed', 'awaiting_human', 'attention'].includes(node.status) &&
        JSON.stringify(node.evidence) === JSON.stringify(args.evidence)) return node;
    if (node.status !== 'verifying') throw new Error('Node is not ready for verification');
    if (args.review) await assertGraphReviewOwnershipTx(tx, node.id, args.review.phase, args.review.claimKey, args.review.taskRunId);
    if (args.review?.outcome === 'platform_failure') {
      const failed = await tx.taskRun.findUniqueOrThrow({ where: { id: args.review.taskRunId }, select: { status: true } });
      if (!['failed', 'cancelled', 'interrupted'].includes(failed.status) || !await taskRunExitMatches(tx, args.review.taskRunId, writerExit)) throw new Error('Review platform retry requires a finished writer');
    }
    const checks = definition.nodes.find((item) => item.key === args.nodeKey)?.acceptance.checks;
    if (!checks) throw new Error('Acceptance policy missing from snapshot');
    if (agentOwned && node.acceptance === 'agent' && !args.review) throw new Error('Configured Tester publication is required');
    if (node.acceptance === 'human' && args.actorId !== 'system') throw new Error('Human gate must be requested by the coordinator');
    const results = args.evidence?.checks;
    if (!Array.isArray(results) || !args.evidence.summary?.trim() ||
        checks.some((check) => !results.some((item) => item.name === check && item.evidence?.trim()))) {
      throw new Error('Required verification evidence is missing');
    }
    const allPassed = results.every(item => item.passed) && checks.every((check) => results.some((item) => item.name === check && item.passed));
    if (allPassed) await assertCandidateInputsIntegrated(tx, node.id);
    let status = allPassed ? (node.acceptance === 'human' ? 'awaiting_human' : 'passed') : 'attention';
    if (args.review && (args.review.outcome !== 'classified' || args.review.decision)) {
      status = await applyReviewFailureTx(tx, node.id, { phase: args.review.phase, claimKey: args.review.claimKey, identity: args.review.taskRunId,
        kind: args.review.decision ? 'decision_required' : args.review.outcome === 'platform_failure' ? 'platform_failure' : 'protocol_exhausted',
        failure: args.review.decision || { code: args.review.outcome === 'platform_failure' ? 'review_platform_failure' : 'invalid_review_result', detail: args.evidence.summary } });
    }
    if (args.review && !allPassed) {
      await tx.taskRunFeishuRelay.updateMany({ where: { taskRunId: args.review.taskRunId }, data: { lastStatus: 'publication_pending' } });
      const replyRun = await tx.taskRun.findUniqueOrThrow({ where: { id: args.review.taskRunId } });
      await tx.taskRun.update({ where: { id: replyRun.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(replyRun.controlMetadata || '{}'),
        graphReplyFailure: { kind: args.review.outcome === 'classified' && !args.review.decision ? 'formal_acceptance' : 'review_execution',
          phase: args.review.phase, evidence: args.evidence.summary } }) } });
    }
    const updated = await tx.taskGraphNode.update({ where: { id: node.id }, data: { status,
      evidence: args.evidence as unknown as Prisma.InputJsonValue, passedAt: status === 'passed' ? new Date() : undefined } });
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: node.id, idempotencyKey: `node:${args.nodeKey}:verified${args.review ? `:${args.review.taskRunId}` : args.attempt ? `:${args.attempt}` : ''}`,
        kind: status === 'passed' ? 'node_passed' : status === 'awaiting_human' ? 'human_review_requested' : 'verification_failed',
        payload: { actorId: args.actorId, evidence: args.evidence as unknown as Prisma.InputJsonValue, ...(args.review ? { review: { phase: args.review.phase, claimKey: args.review.claimKey, taskRunId: args.review.taskRunId } } : {}) } },
    });
    return updated;
  });
}

export async function approveHumanNode(args: {
  runId: string; nodeKey: string; reviewerId: string; approved: boolean; note: string;
}, db: Database = prisma) {
  required(args.note, 'review note');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE "runId" = ${args.runId} AND key = ${args.nodeKey} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId: args.runId, key: args.nodeKey } } });
    if (!node || node.acceptance !== 'human') {
      throw new Error('Node is not awaiting human review');
    }
    if (node.reviewerId !== args.reviewerId) throw new Error('Wrong human reviewer');
    if ((node.status === 'passed' && args.approved) || (node.status === 'attention' && !args.approved)) {
      const decision = await tx.taskGraphEvent.findUnique({
        where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: `node:${args.nodeKey}:human_decision` } },
      });
      if (decision && JSON.stringify(decision.payload) === JSON.stringify({ reviewerId: args.reviewerId, note: args.note })) return node;
    }
    if (node.status !== 'awaiting_human') throw new Error('Node is not awaiting human review');
    const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: args.runId }, select: { snapshot: true } });
    if (args.approved && (run.snapshot as unknown as GraphDefinition).deliveryContract === 'agent_owned_v1') {
      const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      const formal = await tx.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'human_review_requested' }, orderBy: { createdAt: 'desc' } });
      const payload = formal?.payload;
      const evidence = node.evidence;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isDeepStrictEqual(payload.evidence, evidence) ||
          !evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !jobs.length || jobs.some(job => job.status !== 'integrated' || !job.commit) ||
          !isDeepStrictEqual(evidence.inputs, verificationInputs(jobs))) throw new Error('Formal quality record does not match current input commits');
    }
    if (args.approved) await assertCandidateInputsIntegrated(tx, node.id);
    const updated = await tx.taskGraphNode.update({
      where: { id: node.id }, data: { status: args.approved ? 'passed' : 'attention',
        passedAt: args.approved ? new Date() : undefined },
    });
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: node.id, idempotencyKey: `node:${args.nodeKey}:human_decision`,
        kind: args.approved ? 'node_passed' : 'human_review_rejected',
        payload: { reviewerId: args.reviewerId, note: args.note } },
    });
    return updated;
  });
}

export async function recordExecutionIssue(args: {
  runId: string; nodeKey: string; executionKey: string; claimToken: string;
  kind: 'integration_conflict' | 'test_failed' | 'dispatch_failed' | 'input_preparation_failed'; detail: string;
}, db: Database = prisma) {
  required(args.detail, 'issue detail');
  const current = await db.taskGraphExecution.findFirst({ where: { key: args.executionKey, node: { runId: args.runId, key: args.nodeKey } } });
  const progress = executionProgress(current?.dispatchMetadata);
  if (current && progress) return applyExecutionOutcome({ executionId: current.id, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:issue`,
    outcome: { kind: 'decision_required', failure: { code: args.kind, detail: args.detail } },
  }, db);
  return db.$transaction(async (tx) => {
    const execution = await tx.taskGraphExecution.findFirst({
      where: { key: args.executionKey, node: { runId: args.runId, key: args.nodeKey } },
    });
    if (!execution || execution.status !== 'claimed' || execution.claimToken !== args.claimToken) {
      throw new Error('Execution claim mismatch');
    }
    await tx.taskGraphExecution.update({ where: { id: execution.id }, data: { status: 'attention', issueKind: args.kind } });
    await tx.taskGraphNode.update({ where: { id: execution.nodeId }, data: { status: 'attention' } });
    await tx.taskGraphEvent.create({ data: { runId: args.runId, nodeId: execution.nodeId,
      idempotencyKey: `execution:${args.nodeKey}:${args.executionKey}:issue:${args.claimToken}`, kind: args.kind,
      payload: { detail: args.detail } } });
  });
}

/** Ready jobs can be claimed; claimed jobs are returned for reconciliation only. */
export async function listTaskGraphWork(runId: string, db: Database = prisma) {
  return db.taskGraphExecution.findMany({
    where: { node: { runId }, status: { in: ['ready', 'claimed', 'attention'] } },
    include: { node: { select: { key: true, status: true, claimToken: true } } },
    orderBy: [{ node: { key: 'asc' } }, { key: 'asc' }],
  });
}

/** An ambiguous old claim is surfaced for review, never dispatched a second time. */
export async function flagStaleExecutionClaim(args: {
  runId: string; nodeKey: string; executionKey: string; claimToken: string; claimedBefore: Date;
}, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const execution = await tx.taskGraphExecution.findFirst({
      where: { key: args.executionKey, node: { runId: args.runId, key: args.nodeKey } },
    });
    if (!execution) throw new Error('Unknown graph execution');
    if (executionProgress(execution.dispatchMetadata)) throw new Error('Versioned execution recovery requires actual writer ownership proof');
    const updated = await tx.taskGraphExecution.updateMany({
      where: { id: execution.id, status: 'claimed', claimToken: args.claimToken,
        claimedAt: { lt: args.claimedBefore } },
      data: { status: 'attention', issueKind: 'stale_claim' },
    });
    if (updated.count === 0) return false;
    await tx.taskGraphNode.updateMany({ where: { id: execution.nodeId, status: 'claimed' }, data: { status: 'attention' } });
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: execution.nodeId,
        idempotencyKey: `execution:${args.nodeKey}:${args.executionKey}:stale_claim`,
        kind: 'stale_claim', payload: { claimToken: args.claimToken } },
    });
    return true;
  });
}

export async function refreshTaskGraphRunStatus(runId: string, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const nodes = await tx.taskGraphNode.findMany({ where: { runId }, select: { status: true } });
    const status = graphRunBusinessStatus(nodes);
    await tx.taskGraphRun.updateMany({ where: { id: runId, status: { not: 'paused' } }, data: { status } });
    return tx.taskGraphRun.findUniqueOrThrow({ where: { id: runId } });
  });
}
