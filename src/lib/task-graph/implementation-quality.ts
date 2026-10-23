import type { TaskGraphExecution } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { selfCheckExecution, verificationInputs, type GraphNode } from './domain';
import { isRecord, type ImplementationResult } from './implementation-result';

/** Consume the strictly parsed delivery receipt, not the TaskRun's prose summary. */
export function implementationQuality(node: GraphNode, jobs: TaskGraphExecution[]) {
  const owner = jobs.find(job => job.key === selfCheckExecution(node));
  const receipt = owner?.evidence;
  if (!owner || !isRecord(receipt) || receipt.taskRunId !== owner.taskRunId || receipt.integratedCommit !== owner.commit ||
      !isDeepStrictEqual(receipt.ticketInputs, verificationInputs(jobs)) || !isRecord(receipt.implementation) ||
      receipt.implementation.status !== 'delivered' || !isRecord(receipt.implementation.ticketVerification)) return null;
  const delivery = receipt.implementation as Extract<ImplementationResult, { status: 'delivered' }>;
  return { owner, decision: delivery.ticketVerification! };
}
