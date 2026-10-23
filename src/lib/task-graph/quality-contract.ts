import type { TaskGraphExecution, Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { effectiveArchitectureReview, type GraphDefinition, type GraphNode } from './domain';
import { executionProgress } from './execution-progress';
import { isRecord } from './implementation-result';
import { observeTaskRunWriter } from './writer-ownership';
import { classifyReview, graphReviewChecks, type ClassifiedReview, type ReviewCheck } from './review-contract';
import type { ReviewPublication } from './review-publication';
import type { VerificationEvidence } from './store';

/** The first approved implementation owns whole-ticket self-checks, unless a Tester was selected. */
export function qualityOwner(node: GraphNode) {
  const implementation = node.executions[0];
  if (!implementation) throw new Error('Quality responsibility has no implementor');
  return node.acceptance.mode === 'agent'
    ? { actorId: node.acceptance.reviewerId!, launchConfig: node.acceptance.reviewLaunchConfig }
    : { actorId: implementation.agentSelector, launchConfig: implementation.launchConfig };
}

export function verificationInputs(jobs: Pick<TaskGraphExecution, 'id' | 'commit'>[]) {
  return jobs.map(job => ({ executionId: job.id, commit: job.commit })).sort((a, b) => a.executionId.localeCompare(b.executionId));
}

export function qualityCheckEvidence(node: GraphNode, checks: ReviewCheck[], decision: ClassifiedReview | null) {
  return checks.map(check => {
    const item = decision && 'checks' in decision ? decision.checks?.find(item => item.name === check.id) : undefined;
    return { name: node.acceptance.checks.some(name => check.id === `acceptance:${encodeURIComponent(name)}`) ? check.name : check.id,
      passed: item?.passed === true,
      evidence: item?.evidence || decision?.note || '责任 Agent 未提供有效逐项验收证据' };
  });
}

/** Validate eligibility of a quality publication, without running or interpreting business tests. */
export async function assertQualityPublication(tx: Prisma.TransactionClient, args: {
  definition: GraphDefinition; nodeKey: string; nodeId: string; actorId: string;
  evidence: VerificationEvidence; review?: ReviewPublication;
}) {
  const planned = args.definition.nodes.find(node => node.key === args.nodeKey);
  if (!planned || qualityOwner(planned).actorId !== args.actorId) throw new Error('Wrong responsible quality actor');
  const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId: args.nodeId } });
  if (!jobs.length || jobs.some(job => job.status !== 'integrated' || !job.commit) || !isDeepStrictEqual(args.evidence.inputs, verificationInputs(jobs))) throw new Error('Verification input commits changed');
  const required = graphReviewChecks(args.definition, args.nodeKey, jobs).map(check =>
    planned.acceptance.checks.some(name => check.id === `acceptance:${encodeURIComponent(name)}`) ? check.name : check.id);
  const results = args.evidence.checks;
  if (!Array.isArray(results) || new Set(results.map(item => item.name)).size !== results.length ||
      results.some(item => typeof item.passed !== 'boolean' || typeof item.evidence !== 'string' || !item.evidence.trim()) ||
      required.some(name => !results.some(item => item.name === name))) throw new Error('Required quality check evidence missing');
  if (!args.review) throw new Error('Quality review publication ownership required');
  if (jobs.some(job => {
    const binding = executionProgress(job.dispatchMetadata)?.review;
    return binding?.kind !== 'running' || binding.taskRunId !== args.review?.taskRunId || binding.claimKey !== args.review.claimKey || binding.phase !== args.review.phase || binding.candidateCommit !== job.commit;
  })) throw new Error('Quality review ownership changed');
  const architecture = effectiveArchitectureReview(args.definition, planned);
  const allPassed = results.every(item => item.passed);
  if (args.review.phase !== 'acceptance' && (allPassed || !architecture)) throw new Error('Acceptance quality publication required');
  const config = args.review.phase === 'architecture' ? architecture?.reviewLaunchConfig : qualityOwner(planned).launchConfig;
  if (!isRecord(config) || !isRecord(config.participant)) throw new Error('Quality responsible launch identity missing');
  const expected = config.participant;
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: args.review.taskRunId }, include: { participants: true } });
  const taskId = `task-graph-${args.review.phase === 'architecture' ? 'architecture' : 'review'}-${args.nodeId}`;
  if (run.taskId !== taskId || (args.review.outcome !== 'platform_failure' && run.status !== 'completed') ||
      (await observeTaskRunWriter(run.id)).kind !== 'exited' || run.participants.length !== 1 || !run.participants.every(participant =>
        participant.gatewayId === expected.gatewayId && participant.executionBackend === expected.executionBackend &&
        participant.harnessType === expected.harnessType && participant.role === expected.role && (participant.agentId || undefined) === expected.agentId)) throw new Error('Quality review runtime identity or writer mismatch');
  if (args.review.phase === 'acceptance' && args.review.outcome === 'classified' && !args.review.decision) {
    const response = run.participants[0].summary || run.summary || '';
    const matches = Array.from(response.matchAll(/TASK_GRAPH_REVIEW\s*(\{[^\r\n]+\})/g));
    const match = matches.length === 1 ? matches[0] : null;
    let raw: unknown;
    try { raw = match ? JSON.parse(match[1]) : null; } catch { raw = null; }
    const checks = graphReviewChecks(args.definition, args.nodeKey, jobs);
    const decision = classifyReview(raw, checks, true);
    if (!decision || (allPassed && decision.approved !== true) ||
        !isDeepStrictEqual(results.filter(item => required.includes(item.name)), qualityCheckEvidence(planned, checks, decision))) throw new Error('Quality evidence does not match responsible Agent result');
  }
  if (allPassed && architecture) {
    const approved = await tx.taskGraphEvent.findFirst({ where: { nodeId: args.nodeId, kind: 'architecture_passed' }, orderBy: { createdAt: 'desc' } });
    if (!approved || !isRecord(approved.payload) || !isDeepStrictEqual(approved.payload.inputs, verificationInputs(jobs))) throw new Error('Approved architecture evidence does not match input commits');
  }
}
