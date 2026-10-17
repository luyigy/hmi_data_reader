import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { VerificationEvidence } from './store';

export type ReviewDecision = { approved?: unknown; note?: unknown; failureKind?: unknown; failureKey?: unknown };
export const MAX_AUTO_REPAIR_ATTEMPTS = 2;

/** Only a classified, approved-scope defect can requeue the original implementation jobs. */
export async function scheduleGraphRepair(runId: string, nodeKey: string, decision: ReviewDecision, evidence: VerificationEvidence) {
  if (decision.failureKind !== 'in_scope_defect' || typeof decision.note !== 'string' || !decision.note.trim()) return false;
  const note = decision.note;
  return prisma.$transaction(async tx => {
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true, run: true } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const current = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
    if (current.status !== 'attention' || node.executions.some(job => job.status !== 'integrated')) return false;
    const snapshot = node.run.snapshot as unknown as { nodes: { key: string; acceptance: { checks: string[] } }[] };
    const checks = snapshot.nodes.find(item => item.key === nodeKey)?.acceptance.checks || [];
    if (typeof decision.failureKey !== 'string' || !checks.includes(decision.failureKey)) return false;
    const previous = await tx.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
    if (previous >= MAX_AUTO_REPAIR_ATTEMPTS) {
      await tx.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repair:exhausted`, kind: 'node_repair_exhausted', payload: { attempts: previous, note, evidence } }], skipDuplicates: true });
      return false;
    }
    const attempt = previous + 1;
    const fingerprint = createHash('sha256').update(decision.failureKey).digest('hex');
    await tx.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:repair:${attempt}`, kind: 'node_repair_scheduled',
      payload: { attempt, fingerprint, failureKey: decision.failureKey, note, evidence,
        previousExecutions: node.executions.map(job => ({ id: job.id, key: job.key, commit: job.commit, evidence: job.evidence, taskRunId: job.taskRunId, sessionId: job.sessionId, dispatchMetadata: job.dispatchMetadata })) } } });
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'ready', passedAt: null, claimToken: null, claimedAt: null } });
    await tx.taskGraphExecution.updateMany({ where: { nodeId: node.id }, data: { status: 'ready', claimToken: null, claimedAt: null, issueKind: null, taskRunId: null, sessionId: null, dispatchMetadata: Prisma.DbNull } });
    return true;
  });
}

export async function latestGraphRepair(nodeId: string) {
  return prisma.taskGraphEvent.findFirst({ where: { nodeId, kind: 'node_repair_scheduled' }, orderBy: { createdAt: 'desc' } });
}
