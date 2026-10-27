import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { Prisma } from '@prisma/client';
import type { GraphDefinition } from './domain';
import { parseInputManifest } from './input-manifest';
import { isRecord } from './implementation-result';

/** Publication binds supplemental inputs to their authorized receipt, without moving any branch. */
export async function assertCandidateInputBindings(tx: Prisma.TransactionClient, nodeId: string) {
  const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId }, include: { node: true } });
  if (!jobs.length) return;
  const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: jobs[0].node.runId }, select: { snapshot: true } });
  const definition = run.snapshot as unknown as GraphDefinition;
  const allowed = new Set<string>();
  const visit = (key: string) => {
    if (allowed.has(key)) return;
    allowed.add(key);
    for (const parent of definition.nodes.find(node => node.key === key)?.dependsOn || []) visit(parent);
  };
  visit(jobs[0].node.key);
  for (const job of jobs) {
    const pin = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
      runId: job.node.runId, idempotencyKey: `execution:${job.id}:inputs:${job.claimToken || 'legacy'}` } } });
    if (!pin) {
      if (await tx.taskGraphEvent.count({ where: { nodeId, kind: 'task_input_candidate_applied', payload: { path: ['executionId'], equals: job.id } } })) throw new Error('补充候选缺少本轮固定输入，不能完成交付');
      continue;
    }
    for (const input of parseInputManifest(pin.payload).inputs.filter(item => item.replacement)) {
      const event = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: input.replacement!.eventId } });
      const payload = event.payload;
      if (event.runId !== job.node.runId || event.kind !== 'task_input_candidate_registered' || !isRecord(payload) ||
          !isRecord(payload.receipt) || typeof payload.receipt.executionId !== 'string' || payload.receipt.repository !== input.repository ||
          payload.receipt.candidateCommit !== input.commit || payload.receipt.previousCommit !== input.replacement!.previousCommit) throw new Error('补充候选的授权来源无效');
      const origin = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: payload.receipt.executionId }, include: { node: true } });
      if (origin.nodeId !== event.nodeId || !allowed.has(origin.node.key) ||
          (event.nodeId === nodeId && origin.id !== job.id)) throw new Error('补充候选不属于本次交付或其前置');
    }
  }
}

/** Supplemental input changes invalidate cached reviews even when the primary commit is unchanged. */
export async function candidateReviewFallback(nodeId: string, fallback: string) {
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId, kind: 'task_input_candidate_applied' }, select: { id: true }, orderBy: { id: 'asc' } });
  return events.length ? `${fallback}:inputs:${createHash('sha256').update(JSON.stringify(events.map(event => event.id))).digest('hex').slice(0, 24)}` : fallback;
}
