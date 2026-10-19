import { prisma } from '../prisma';
import { pendingReviewRepairTx } from './pending-review-repair-contract';
import { scheduleGraphRepair } from './repair';
import { redactSensitiveText } from '../redact-sensitive';

export async function recoverPendingReviewRepairs(runId: string) {
  const nodes = await prisma.taskGraphNode.findMany({ where: { runId, status: 'attention', executions: { some: {}, every: { status: 'integrated' } } }, select: { id: true, key: true } });
  for (const node of nodes) {
    try {
      const pending = await prisma.$transaction(tx => pendingReviewRepairTx(tx, node.id));
      if (pending) await scheduleGraphRepair(runId, node.key, pending.decision, pending.evidence, pending.binding);
    } catch (error) {
      console.error('[TaskGraph] review repair pickup deferred:', { runId, nodeKey: node.key,
        reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) });
    }
  }
}
