import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { graphAssociationForTask } from '../task-graph/graph-association';

export type CompletionOwner = { kind: 'graph'; runId: string; nodeId: string }
  | { kind: 'handover'; projectId: string; jobId: string }
  | { kind: 'conversation' };

/** Registered task/dispatch relations select exactly one workflow, never names or files. */
export async function resolveCompletionOwner(taskId: string, tx: Prisma.TransactionClient = prisma): Promise<CompletionOwner> {
  const graph = await graphAssociationForTask(taskId, '', tx);
  const rooms = await tx.liveRoom.findMany({ where: { sourceTaskId: taskId }, select: { id: true } });
  const dispatches = await tx.workflowDispatch.findMany({ where: { roomId: { in: rooms.map(room => room.id) },
    messageId: { not: null }, state: { in: ['prompt_posted', 'reply_queued', 'completed', 'failed'] } }, select: { projectId: true, jobId: true, roomId: true, messageId: true } });
  const workflows = new Map<string, { projectId: string; jobId: string }>();
  for (const dispatch of dispatches) {
    const message = await tx.liveRoomMessage.findUnique({ where: { id: dispatch.messageId! }, select: { roomId: true } });
    if (message?.roomId !== dispatch.roomId) throw new Error('Workflow dispatch message does not belong to its registered room');
    workflows.set(JSON.stringify([dispatch.projectId, dispatch.jobId]), { projectId: dispatch.projectId, jobId: dispatch.jobId });
  }
  if (workflows.size > 1 || graph && workflows.size) throw new Error('Task has conflicting registered workflow owners');
  if (graph) return { kind: 'graph', runId: graph.runId, nodeId: graph.nodeId };
  const handover = workflows.values().next().value;
  return handover ? { kind: 'handover', ...handover } : { kind: 'conversation' };
}

export async function taskRunCompletionOwner(taskRunId: string): Promise<CompletionOwner> {
  const turn = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
  const saved = JSON.parse(turn.controlMetadata || '{}').completionOwner;
  const current = await resolveCompletionOwner(turn.taskId);
  if (!saved || !isDeepStrictEqual(saved, current)) throw new Error('TaskRun workflow owner changed during execution');
  return current;
}
