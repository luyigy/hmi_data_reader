import { conversationTargetWasReset } from './conversation-reset';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { executionProgress, type ExecutionProgress } from './execution-progress';
import { authorizedConversationInput, type ConversationInput } from './conversation-inbox';
import { assertConversationTargetRun, isImplementationInput } from './conversation-target';

/** Receiving a message does not resolve a permission, scope, or controlled repair hold. */
export function conversationImplementationHold(progress: ExecutionProgress): string | undefined {
  if (!['implement', 'collect_result'].includes(progress.phase)) return 'implementation_phase_required';
  if (progress.state === 'ownership_attention' || progress.lastFailure?.code === 'ownership_mismatch') return 'ownership_unresolved';
  if (progress.conflictRepair || progress.lastFailure?.code === 'integration_conflict') return 'controlled_conflict_required';
  if (progress.lastFailure?.requiresUserDecision || ['permission_required', 'scope_change', 'resource_application_failed', 'agent_capability_missing'].includes(progress.lastFailure?.code || '')) return 'human_input_required';
}

/** Keep one source message per turn, and leave other roles/older sessions on their read-only path. */
export async function implementationConversationInputs(tx: Prisma.TransactionClient, job: TaskGraphExecution, inputs: ConversationInput[], allRoots = false) {
  const progress = executionProgress(job.dispatchMetadata);
  if (!job.childTaskId || !progress || conversationImplementationHold(progress)) return [];
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId }, include: { run: { include: { parentTask: true } } } });
  const ownerId = progress.conversationOwnerRunId || progress.taskRunId || job.taskRunId;
  const eligible: ConversationInput[] = [];
  for (const input of inputs) {
    if (!isImplementationInput(input) || !await authorizedConversationInput(input, job.childTaskId, node.run.parentTask.ownerUserId, tx)) continue;
    if (await conversationTargetWasReset(tx, job, input.target)) continue;
    if (ownerId && !(input.target?.kind === 'session' && input.target.resetSourceSessionId)) {
      try { await assertConversationTargetRun(tx, input.target, ownerId); } catch { continue; }
    }
    if (allRoots || !eligible.length || eligible[0].rootInputId === input.rootInputId) eligible.push(input);
  }
  return eligible;
}
