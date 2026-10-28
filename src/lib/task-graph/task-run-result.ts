import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import type { AcpxRunRequest } from '../acpx/types';
import { prisma } from '../prisma';
import { effectiveArchitectureReview, verificationInputs, type GraphDefinition } from './domain';
import { graphAssociationForTask } from './graph-association';
import { executionProgress } from './execution-progress';
import { isRecord } from './implementation-result';
import { graphReviewChecks, type ReviewCheck } from './review-contract';
import { parseGraphResult, type GraphResultMarker, type GraphResult } from './result-protocol';

export type ResultBinding = {
  deliveryContract?: GraphDefinition['deliveryContract'];
  version: 1; runId: string; nodeId: string; taskId: string; taskRunId: string;
  source: 'scheduled' | 'room'; marker: GraphResultMarker | null; snapshotHash: string;
  executionIds: string[]; inputs: { executionId: string; commit: string | null }[];
  revisions: { executionId: string; revision: number }[];
  checks: ReviewCheck[]; authorized: boolean; authorizationError?: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const actor = (value: unknown) => {
  const item = isRecord(value) ? value : {};
  return Object.fromEntries(['executionBackend', 'harnessType', 'gatewayId', 'agentId', 'role', 'model'].map(key => [key, item[key] || null]));
};

/** Capture server-owned identity while startup holds the shared writer lock. No stage admission. */
export async function bindTaskRunResult(tx: Prisma.TransactionClient, request: AcpxRunRequest, taskRunId: string) {
  const association = await graphAssociationForTask(request.taskId, request.participants[0]?.role || '', tx);
  const nodeId = request.graphReview?.nodeId || association?.nodeId;
  if (!nodeId) return;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true, run: true } });
  if (association && (association.runId !== node.runId || association.nodeId !== node.id) || request.graphReview && request.graphReview.runId !== node.runId) throw new Error('Result binding graph identity mismatch');
  const definition = node.run.snapshot as unknown as GraphDefinition;
  const planned = definition.nodes.find(item => item.key === node.key);
  if (!planned) throw new Error('Result policy missing from approved snapshot');
  const job = node.executions.find(item => item.childTaskId === request.taskId);
  let phase = request.graphReview?.phase;
  if (!job && !phase) {
    const history = await tx.taskRun.findMany({ where: { taskId: request.taskId, controlMetadata: { contains: 'graphReview' } }, orderBy: { createdAt: 'desc' } });
    const registered = history.flatMap(turn => {
      const review = JSON.parse(turn.controlMetadata || '{}').graphReview;
      return review?.nodeId === node.id && review.runId === node.runId && ['architecture', 'acceptance'].includes(review.phase) ? [review.phase] : [];
    });
    // Missing legacy publication identity must not disable ordinary work.
    phase = new Set(registered).size === 1 ? registered[0] : undefined;
  }
  const config = job ? job.launchConfig : phase === 'architecture' ? effectiveArchitectureReview(definition, planned)?.reviewLaunchConfig : planned.acceptance.reviewLaunchConfig;
  const approved = isRecord(config) ? config.participant : undefined;
  const authorized = request.participants.length === 1 && !!approved && isDeepStrictEqual(actor(request.participants[0]), actor(approved)) &&
    (!!job || phase === 'architecture' || phase === 'acceptance' && planned.acceptance.mode === 'agent');
  const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
  const metadata = JSON.parse(turn.controlMetadata || '{}');
  const historicalInputs = !job && Array.isArray(metadata.reviewCandidates)
    ? metadata.reviewCandidates.map((item: { id: string; commit: string }) => ({ executionId: item.id, commit: item.commit })).sort((a: { executionId: string }, b: { executionId: string }) => a.executionId.localeCompare(b.executionId)) : undefined;
  const binding: ResultBinding = {
    ...(definition.deliveryContract === 'agent_commit_v1' ? { deliveryContract: definition.deliveryContract } : {}),
    version: 1, runId: node.runId, nodeId: node.id, taskId: request.taskId, taskRunId,
    source: request.graphExecution || request.graphReview ? 'scheduled' : 'room',
    marker: job ? 'TASK_GRAPH_IMPLEMENTATION' : phase === 'architecture' ? 'TASK_GRAPH_ARCH_REVIEW' : phase === 'acceptance' ? 'TASK_GRAPH_REVIEW' : null,
    snapshotHash: hash(JSON.stringify(node.run.snapshot)), executionIds: job ? [job.id] : node.executions.map(item => item.id).sort(),
    inputs: historicalInputs || verificationInputs(node.executions), revisions: node.executions.map(item => ({ executionId: item.id, revision: executionProgress(item.dispatchMetadata)?.revision || 0 })).sort((a, b) => a.executionId.localeCompare(b.executionId)),
    checks: graphReviewChecks(definition, node.key, node.executions).filter(check => phase === 'architecture' || check.id !== 'architecture:scope'),
    authorized, ...(!authorized ? { authorizationError: !job && !phase ? '缺少唯一的已登记复核角色；对话保留，不能发布正式结果' : '运行参与者与批准的实施/验收配置不一致；对话保留，不能发布正式结果' } : {}),
  };
  if (metadata.graphResultBinding && !isDeepStrictEqual(metadata.graphResultBinding, binding)) throw new Error('TaskRun result identity is immutable');
  await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...metadata, graphResultBinding: binding }) } });
}

/** Durable intake only: this event is not an acceptance or a candidate update. */
export async function recordTaskRunResult(taskRunId: string) {
  return prisma.$transaction(async tx => {
    const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
    const metadata = JSON.parse(turn.controlMetadata || '{}');
    const binding = metadata.graphResultBinding as ResultBinding | undefined;
    if (!binding) return null; // Historical turns have no new publication authority.
    if (binding.version !== 1 || binding.taskId !== turn.taskId || binding.taskRunId !== turn.id) throw new Error('TaskRun result binding mismatch');
    if (turn.status !== 'completed') return null;
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${binding.nodeId} FOR UPDATE`;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: binding.nodeId }, include: { run: true } });
    if (node.runId !== binding.runId || hash(JSON.stringify(node.run.snapshot)) !== binding.snapshotHash) throw new Error('Result snapshot identity changed');
    const output = turn.participants.length === 1 ? turn.participants[0].summary || turn.summary || '' : turn.summary || '';
    let result = parseGraphResult(output, binding.marker || '', binding.checks);
    if (result.kind !== 'conversation' && (!binding.authorized || turn.participants.length !== 1 || turn.participants[0].status !== 'completed')) result = { kind: 'invalid', note: binding.authorizationError || '正式结果没有唯一成功的参与者' };
    const payload = { taskRunId, binding, outputHash: hash(output), result };
    const idempotencyKey = `task-run-result:${taskRunId}`;
    const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: binding.runId, idempotencyKey } } });
    if (previous) {
      if (!isDeepStrictEqual(previous.payload, payload)) throw new Error('Completed TaskRun result changed after recording');
      return { eventId: previous.id, binding, result };
    }
    const event = await tx.taskGraphEvent.create({ data: { runId: binding.runId, nodeId: binding.nodeId, idempotencyKey,
      kind: 'task_run_result_recorded', payload: payload as unknown as Prisma.InputJsonValue } });
    return { eventId: event.id, binding, result };
  });
}

/** A restart can collect an already completed turn without launching another Agent. */
export async function recordedImplementationResult(taskRunId: string, fallback: string, checks: ReviewCheck[]): Promise<GraphResult> {
  const receipt = await recordTaskRunResult(taskRunId);
  return receipt?.result || parseGraphResult(fallback, 'TASK_GRAPH_IMPLEMENTATION', checks);
}
