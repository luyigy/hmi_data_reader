import type { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { executionProgress } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import { observeTaskRunWriter } from './writer-ownership';
import { classifyReview, graphReviewChecks } from './review-contract';
import type { GraphDefinition } from './domain';
import type { VerificationEvidence } from './store';
import { executionRetryLimits } from './retry-limits';

export type PendingReviewRepairBinding = {
  phase: 'architecture' | 'acceptance'; claimKey: string; taskRunId: string;
  executions: { id: string; revision: number; claimToken: string | null; commit: string }[];
};

function verificationEvidence(value: unknown): VerificationEvidence | null {
  if (!value || typeof value !== 'object' || !('summary' in value) || typeof value.summary !== 'string' || !value.summary.trim() ||
      !('checks' in value) || !Array.isArray(value.checks)) return null;
  const checks: VerificationEvidence['checks'] = [];
  for (const check of value.checks) {
    if (!check || typeof check !== 'object' || !('name' in check) || typeof check.name !== 'string' || !check.name.trim() ||
        !('passed' in check) || typeof check.passed !== 'boolean' || !('evidence' in check) || typeof check.evidence !== 'string' || !check.evidence.trim()) return null;
    checks.push({ name: check.name, passed: check.passed, evidence: check.evidence });
  }
  return { summary: value.summary, checks };
}

/** Current execution review bindings, never historical events, identify an unfinished repair handoff. */
export async function pendingReviewRepairTx(tx: Prisma.TransactionClient, nodeId: string) {
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true, run: true } });
  if (node.status !== 'attention' || !['running', 'attention'].includes(node.run.status) || !node.executions.length || node.executions.some(job => job.status !== 'integrated')) return null;
  const first = executionProgress(node.executions[0].dispatchMetadata)?.review;
  if (!first || first.kind !== 'running') return null;
  const executions: PendingReviewRepairBinding['executions'] = [];
  for (const job of node.executions) {
    const progress = executionProgress(job.dispatchMetadata), review = progress?.review;
    if (!progress || progress.state !== 'active' || progress.phase !== first.phase || !job.commit || progress.candidateCommit !== job.commit ||
        job.issueKind === 'retry_exhausted' || !job.claimToken ||
        review?.kind !== 'running' || review.phase !== first.phase || review.claimKey !== first.claimKey || review.taskRunId !== first.taskRunId || review.candidateCommit !== job.commit) return null;
    executions.push({ id: job.id, revision: progress.revision, claimToken: job.claimToken, commit: job.commit });
  }
  const taskRun = await tx.taskRun.findUnique({ where: { id: first.taskRunId }, include: { participants: true } });
  const taskId = `task-graph-${first.phase === 'architecture' ? 'architecture' : 'review'}-${node.id}`;
  if (!taskRun || taskRun.status !== 'completed' || taskRun.taskId !== taskId) return null;
  const definition = node.run.snapshot as unknown as GraphDefinition;
  const marker = first.phase === 'architecture' ? 'TASK_GRAPH_ARCH_REVIEW' : 'TASK_GRAPH_REVIEW';
  const response = taskRun.participants[0]?.summary || taskRun.summary || '';
  const matches = Array.from(response.matchAll(new RegExp('^' + marker + '[ \\t]+(\\{[^\\r\\n]+\\})[ \\t]*$', 'gm')));
  if (matches.length !== 1) return null;
  let raw: unknown; try { raw = JSON.parse(matches[0][1]); } catch { return null; }
  const decision = classifyReview(raw, graphReviewChecks(definition, node.key, node.executions));
  if (!decision || decision.approved || decision.failureKind !== 'in_scope_defect') return null;
  if (node.executions.some(job => decision.executionIds.includes(job.id) && (executionProgress(job.dispatchMetadata)?.repairAttempts || 0) >= executionRetryLimits.repairAttempts)) return null;
  const evidence = verificationEvidence(node.evidence);
  const required = definition.nodes.find(item => item.key === node.key)?.acceptance.checks;
  if (!evidence || !required || required.some(name => !evidence.checks.some(check => check.name.trim() === name.trim() && check.evidence.trim())) || evidence.checks.every(check => check.passed)) return null;
  if ((await observeTaskRunWriter(first.taskRunId)).kind !== 'exited') throw new Error(`Pending review repair ${node.key}: reviewer writer has not proven exit`);
  for (const job of node.executions) if ((await observeExecutionWriter(job)).kind !== 'exited') throw new Error(`Pending review repair ${node.key}/${job.key}: phase or implementation writer has not proven exit`);
  const binding: PendingReviewRepairBinding = { phase: first.phase, claimKey: first.claimKey, taskRunId: first.taskRunId, executions: executions.sort((a, b) => a.id.localeCompare(b.id)) };
  return { binding, decision, evidence };
}

export async function assertPendingReviewRepairTx(tx: Prisma.TransactionClient, nodeId: string,
  expected: PendingReviewRepairBinding, decision: unknown, evidence: VerificationEvidence) {
  const current = await pendingReviewRepairTx(tx, nodeId);
  if (!current || !isDeepStrictEqual(current.binding, expected) || !isDeepStrictEqual(current.decision, decision) || !isDeepStrictEqual(current.evidence, evidence)) throw new Error('Pending review repair binding, result or evidence changed');
}
