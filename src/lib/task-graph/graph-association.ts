import { conversationTargetWasReset } from './conversation-reset';
import { assertConversationTargetRun, parseConversationTarget } from './conversation-target';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/** Identity only. Scheduling claims, phase decisions and retries remain in the graph. */
export type GraphAssociation = {
  runId: string;
  nodeId: string;
  executionIds: string[];
  role: string;
  roomMessageId?: string;
  sourceTaskRunId?: string;
};

export async function graphAssociationForTask(taskId: string, role: string, tx: Prisma.TransactionClient = prisma): Promise<GraphAssociation | undefined> {
  const child = await tx.taskGraphExecution.findUnique({ where: { childTaskId: taskId }, include: { node: true } });
  if (child) return { runId: child.node.runId, nodeId: child.nodeId, executionIds: [child.id], role };
  // Review tasks are registered by their historical runner binding, not inferred
  // from a user-supplied task prefix or the current node phase.
  const runs = await tx.taskRun.findMany({ where: { taskId, controlMetadata: { contains: 'graphReview' } }, orderBy: { createdAt: 'desc' } });
  for (const run of runs) {
    let binding;
    try { binding = JSON.parse(run.controlMetadata || '{}').graphReview; } catch { continue; }
    if (!binding || typeof binding.nodeId !== 'string' || typeof binding.runId !== 'string') continue;
    const node = await tx.taskGraphNode.findUnique({ where: { id: binding.nodeId }, include: { executions: true } });
    if (!node || node.runId !== binding.runId) throw new Error('Registered graph task association is invalid');
    return { runId: node.runId, nodeId: node.id, executionIds: node.executions.map(job => job.id).sort(), role };
  }
  return undefined;
}

/** Resolve resource ownership from persisted task bindings, never a task-name prefix. */
export async function graphResourceJobs(taskId: string, tx: Prisma.TransactionClient = prisma) {
  const association = await graphAssociationForTask(taskId, '', tx);
  return association ? tx.taskGraphExecution.findMany({ where: { id: { in: association.executionIds }, nodeId: association.nodeId },
    include: { node: { include: { run: { include: { parentTask: true } } } } }, orderBy: { key: 'asc' } }) : [];
}

/** Carry all historical review inputs, including multi-repository candidates. */
export async function associationReviewCandidates(taskId: string, association?: GraphAssociation) {
  if (!association?.sourceTaskRunId) return undefined;
  const source = await prisma.taskRun.findUniqueOrThrow({ where: { id: association.sourceTaskRunId }, include: { participants: true } });
  if (source.taskId !== taskId || !source.participants.some(participant => participant.role === association.role)) throw new Error('Conversation source run belongs to another task or role');
  const candidates = JSON.parse(source.controlMetadata || '{}').reviewCandidates;
  if (association.role === 'implementer') return undefined;
  if (!Array.isArray(candidates) || candidates.length !== association.executionIds.length ||
      candidates.some(item => !association.executionIds.includes(item.id) || typeof item.commit !== 'string') ||
      new Set(candidates.map(item => item.id)).size !== candidates.length) throw new Error('Historical review candidate set is incomplete');
  return candidates;
}

export async function assertRoomRunTarget(tx: Prisma.TransactionClient, association: GraphAssociation, taskRunId: string) {
  const target = await tx.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: {
    runId: association.runId, idempotencyKey: `room-target:${association.roomMessageId}`,
  } } });
  if (target.nodeId !== association.nodeId || target.kind !== 'room_conversation_target') throw new Error('Room target association changed');
  const message = await tx.liveRoomMessage.findUniqueOrThrow({ where: { id: association.roomMessageId }, include: { room: true } });
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId: message.room.sourceTaskId || '' } });
  if (job.nodeId !== association.nodeId) throw new Error('Room execution association changed');
  const captured = parseConversationTarget(target.payload);
  if (captured?.kind === 'session') {
    const original = await tx.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: captured.taskRunId, role: captured.role } });
    const metadata = JSON.parse(original.controlMetadata || '{}');
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
    const participant = run.participants.find(item => item.role === captured.role);
    const fresh = participant && !JSON.parse(participant.controlMetadata || '{}').resumeSessionId;
    if (fresh && metadata.continuationStaleAt && metadata.continuationStaleReason) {
      if (run.taskId !== captured.taskId || run.taskSessionId !== captured.taskSessionId || await conversationTargetWasReset(tx, job, captured)) throw new Error('Expired native session fallback changed task identity');
      return;
    }
  }
  await assertConversationTargetRun(tx, captured, taskRunId, job.id);
}
