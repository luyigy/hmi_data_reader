import { prisma } from '../prisma';

/** Compatibility entry for trusted review callers; the shared boundary preserves the fixed review stage. */
export async function scheduleVerificationRecovery(runId: string, nodeKey: string, requestId: string) {
  if (!requestId.trim()) throw new Error('Verification recovery requires a request identity');
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  const { admitNode, AdmissionRefused } = await import('./preparation-recovery');
  const result = await admitNode(node.id, { source: 'operator', id: requestId });
  if (result.kind !== 'admitted' && result.kind !== 'already_scheduled') throw new AdmissionRefused(result);
}
