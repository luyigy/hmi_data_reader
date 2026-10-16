import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { isCompletedNodeStatus, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';

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
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId, key: nodeKey } } });
    if (!node) throw new Error('Unknown graph node');
    if (node.status === 'claimed' && node.claimToken === claimToken) return node;
    const updated = await tx.taskGraphNode.updateMany({
      where: { id: node.id, status: 'ready', claimToken: null },
      data: { status: 'claimed', claimToken, claimedAt: new Date() },
    });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:claimed`, kind: 'node_claimed', payload: { claimToken } },
    });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
  });
}

export async function claimExecution(
  runId: string, nodeKey: string, executionKey: string, claimToken: string, db: Database = prisma,
) {
  required(claimToken, 'claimToken');
  return db.$transaction(async (tx) => {
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId, key: nodeKey } } });
    if (!node || node.status !== 'claimed') return null;
    const execution = await tx.taskGraphExecution.findUnique({ where: { nodeId_key: { nodeId: node.id, key: executionKey } } });
    if (!execution) throw new Error('Unknown graph execution');
    if (execution.status === 'claimed' && execution.claimToken === claimToken) return execution;
    const updated = await tx.taskGraphExecution.updateMany({
      where: { id: execution.id, status: 'ready', claimToken: null },
      data: { status: 'claimed', claimToken, claimedAt: new Date() },
    });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `execution:${nodeKey}:${executionKey}:claimed`,
        kind: 'execution_claimed', payload: { claimToken } },
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
        JSON.stringify(execution.dispatchMetadata) !== JSON.stringify(args.dispatchMetadata)) {
      throw new Error('Conflicting execution dispatchMetadata');
    }
    return tx.taskGraphExecution.update({
      where: { id: execution.id },
      data: {
        childTaskId: args.childTaskId, sessionId: args.sessionId, taskRunId: args.taskRunId,
        worktreePath: args.worktreePath, worktreeBranch: args.worktreeBranch,
        dispatchMetadata: args.dispatchMetadata === undefined ? undefined : args.dispatchMetadata as Prisma.InputJsonValue,
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
    if (!execution.worktreePath || !execution.worktreeBranch) throw new Error('Worktree evidence is required');
    const changed = await tx.taskGraphExecution.updateMany({
      where: { id: execution.id, status: 'claimed', claimToken: args.claimToken },
      data: { status: 'integrated', commit: args.commit, evidence: args.evidence as Prisma.InputJsonValue },
    });
    if (changed.count !== 1) throw new Error('Execution result changed concurrently');
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: execution.nodeId,
        idempotencyKey: `execution:${args.nodeKey}:${args.executionKey}:integrated`,
        kind: 'execution_integrated', payload: { commit: args.commit } },
    });
    return tx.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
  });
}

/** No acceptance can begin while a repository execution is unfinished. */
export async function markNodeIntegrationsReady(runId: string, nodeKey: string, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const node = await tx.taskGraphNode.findUnique({
      where: { runId_key: { runId, key: nodeKey } }, include: { executions: true },
    });
    if (!node) throw new Error('Unknown graph node');
    if (node.status === 'verifying' || node.status === 'awaiting_human' || node.status === 'passed') return node;
    if (node.status !== 'claimed' || node.executions.some((job) => job.status !== 'integrated')) return null;
    const updated = await tx.taskGraphNode.updateMany({ where: { id: node.id, status: 'claimed' }, data: { status: 'verifying' } });
    if (updated.count !== 1) return null;
    await tx.taskGraphEvent.create({
      data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:verifying`, kind: 'node_verifying', payload: {} },
    });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
  });
}

export type VerificationEvidence = {
  checks: { name: string; passed: boolean; evidence: string }[];
  summary: string;
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
    const changed = await tx.taskGraphNode.updateMany({ where: { id: node.id, status: 'verifying' },
      data: { status: 'delivered_unverified', evidence: { summary: '按已批准的仅实施模式交付；未执行独立架构审查或测试验收。' } } });
    if (changed.count === 1) await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id,
      idempotencyKey: `node:${nodeKey}:delivered_unverified`, kind: 'delivered_unverified', payload: {} } });
    return tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
  });
}

/** Agent review requires the configured reviewer; human review creates a pause. */
export async function submitNodeVerification(args: {
  runId: string; nodeKey: string; actorId: string; evidence: VerificationEvidence;
}, db: Database = prisma) {
  return db.$transaction(async (tx) => {
    const node = await tx.taskGraphNode.findUnique({ where: { runId_key: { runId: args.runId, key: args.nodeKey } } });
    if (!node) throw new Error('Unknown graph node');
    if (['passed', 'awaiting_human', 'attention'].includes(node.status) &&
        JSON.stringify(node.evidence) === JSON.stringify(args.evidence)) return node;
    if (node.status !== 'verifying') throw new Error('Node is not ready for verification');
    const snapshot = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: args.runId }, select: { snapshot: true } });
    const definition = snapshot.snapshot as unknown as GraphDefinition;
    const checks = definition.nodes.find((item) => item.key === args.nodeKey)?.acceptance.checks;
    if (!checks) throw new Error('Acceptance policy missing from snapshot');
    if (node.acceptance === 'agent' && node.reviewerId !== args.actorId) throw new Error('Wrong review agent');
    if (node.acceptance === 'human' && args.actorId !== 'system') throw new Error('Human gate must be requested by the coordinator');
    const results = args.evidence?.checks;
    if (!Array.isArray(results) || !args.evidence.summary?.trim() ||
        checks.some((check) => !results.some((item) => item.name === check && item.evidence?.trim()))) {
      throw new Error('Required verification evidence is missing');
    }
    const allPassed = checks.every((check) => results.some((item) => item.name === check && item.passed));
    const status = allPassed ? (node.acceptance === 'human' ? 'awaiting_human' : 'passed') : 'attention';
    const updated = await tx.taskGraphNode.update({
      where: { id: node.id }, data: { status, evidence: args.evidence as unknown as Prisma.InputJsonValue,
        passedAt: status === 'passed' ? new Date() : undefined },
    });
    await tx.taskGraphEvent.create({
      data: { runId: args.runId, nodeId: node.id, idempotencyKey: `node:${args.nodeKey}:verified`,
        kind: status === 'passed' ? 'node_passed' : status === 'awaiting_human' ? 'human_review_requested' : 'verification_failed',
        payload: { actorId: args.actorId, evidence: args.evidence as unknown as Prisma.InputJsonValue } },
    });
    return updated;
  });
}

export async function approveHumanNode(args: {
  runId: string; nodeKey: string; reviewerId: string; approved: boolean; note: string;
}, db: Database = prisma) {
  required(args.note, 'review note');
  return db.$transaction(async (tx) => {
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
  kind: 'integration_conflict' | 'test_failed' | 'dispatch_failed'; detail: string;
}, db: Database = prisma) {
  required(args.detail, 'issue detail');
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
      idempotencyKey: `execution:${args.nodeKey}:${args.executionKey}:issue`, kind: args.kind,
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
    if (nodes.length === 0) throw new Error('Unknown or empty task graph run');
    const status = nodes.every((node) => isCompletedNodeStatus(node.status))
      ? nodes.some((node) => node.status === 'delivered_unverified') ? 'completed_unverified' : 'completed'
      : nodes.some((node) => node.status === 'attention') ? 'attention' : 'running';
    return tx.taskGraphRun.update({ where: { id: runId }, data: { status } });
  });
}
