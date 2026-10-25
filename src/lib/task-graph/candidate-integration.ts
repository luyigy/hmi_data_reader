import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { Prisma } from '@prisma/client';
import { graphGit } from './git-command';
import { parseInputManifest } from './input-manifest';
import { isRecord } from './implementation-result';

/** A candidate is usable for verification before integration, but cannot release successors. */
export async function assertCandidateInputsIntegrated(tx: Prisma.TransactionClient, nodeId: string) {
  const jobs = await tx.taskGraphExecution.findMany({ where: { nodeId }, include: { node: true } });
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
      if (event.nodeId !== nodeId || event.kind !== 'task_input_candidate_registered' || !isRecord(payload) ||
          !isRecord(payload.receipt) || payload.receipt.executionId !== job.id || payload.receipt.repository !== input.repository ||
          payload.receipt.candidateCommit !== input.commit || !Array.isArray(payload.integrationRefs) || !payload.integrationRefs.length ||
          !payload.integrationRefs.every(ref => typeof ref === 'string' && ref.trim())) throw new Error('补充候选的汇合来源无效');
      for (const ref of payload.integrationRefs) {
        const integrated = await graphGit(input.repository, 'merge-base', '--is-ancestor', input.commit, String(ref)).then(() => true, () => false);
        if (!integrated) throw new Error(`补充候选尚未汇合：${input.repository}@${input.commit} → ${ref}；保留验收结果，汇合后重试发布，不能释放后继`);
      }
    }
  }
}

/** Supplemental input changes invalidate cached reviews even when the primary commit is unchanged. */
export async function candidateReviewFallback(nodeId: string, fallback: string) {
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId, kind: 'task_input_candidate_applied' }, select: { id: true }, orderBy: { id: 'asc' } });
  return events.length ? `${fallback}:inputs:${createHash('sha256').update(JSON.stringify(events.map(event => event.id))).digest('hex').slice(0, 24)}` : fallback;
}
