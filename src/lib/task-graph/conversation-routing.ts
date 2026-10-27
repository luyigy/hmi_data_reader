import { conversationTargetWasReset } from './conversation-reset';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { executionProgress } from './execution-progress';
import { authorizedConversationInput, type ConversationInput } from './conversation-inbox';
import { assertConversationTargetRun, isImplementationInput } from './conversation-target';

/** Keep one source message per turn, and leave other roles/older sessions on their registered task. */
export async function implementationConversationInputs(tx: Prisma.TransactionClient, job: TaskGraphExecution, inputs: ConversationInput[], allRoots = false) {
  const progress = executionProgress(job.dispatchMetadata);
  if (!job.childTaskId || !progress) return [];
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
