import { prisma } from '../prisma';
import { resolveConversationTarget, parseConversationTarget } from './conversation-target';
import { conversationContinuation } from './conversation-continuation';
import { graphAssociationForTask } from './graph-association';

/** Capture the destination once before queueing. Replays never retarget a card. */
export async function graphRoomTarget(roomId: string, messageId: string, selectedMemberId?: string | null) {
  const source = await prisma.liveRoom.findUnique({ where: { id: roomId }, select: { sourceTaskId: true } });
  if (!source?.sourceTaskId) return null;
  return prisma.$transaction(async tx => {
    const room = await tx.liveRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
    if (!room.sourceTaskId) return null;
    const job = await tx.taskGraphExecution.findUnique({ where: { childTaskId: room.sourceTaskId }, include: { node: true } });
    if (!job) return null;
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const message = await tx.liveRoomMessage.findFirstOrThrow({ where: { id: messageId, roomId } });
    const key = `room-target:${message.id}`;
    const saved = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } });
    const source = JSON.parse(message.metadata || '{}');
    const memberId = selectedMemberId || source.primaryTargetMemberId || room.currentSpeakerMemberId;
    const target = saved ? parseConversationTarget(saved.payload) : await resolveConversationTarget(tx, job,
      JSON.stringify({ ...source, ...(memberId ? { targetLocked: true, mentionedMemberIds: [memberId], primaryTargetMemberId: memberId } : {}) }));
    if (!target || target.kind === 'unresolved') throw new Error(target?.reason || 'Graph message target is unavailable');
    const original = target.kind === 'session' ? await tx.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: target.taskRunId, role: target.role } }) : null;
    const members = room.members.filter(member => member.role === target.role && member.canReply && member.joinStatus === 'joined' &&
      (!original || member.harnessType === original.harnessType && member.backend === original.executionBackend && member.runtimeAgentId === original.agentId));
    if (members.length !== 1) throw new Error('Graph message has no unique available role member');
    if (!saved) await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'room_conversation_target', idempotencyKey: key, payload: target } });
    return { executionId: job.id, target, memberId: members[0].id };
  });
}

export async function graphRoomContext(roomId: string, messageId: string, selectedMemberId: string) {
  const resolved = await graphRoomTarget(roomId, messageId, selectedMemberId);
  if (!resolved) return null;
  if (resolved.memberId !== selectedMemberId) throw new Error('Queued graph message belongs to another role');
  const session = await conversationContinuation(resolved.executionId, resolved.target);
  const task = await prisma.task.findUniqueOrThrow({ where: { id: session.taskId }, include: { currentTaskSession: true } });
  const association = await graphAssociationForTask(task.id, session.participant.role);
  if (!association) throw new Error('Graph conversation task registration is missing');
  return { session, task, association: { ...association, roomMessageId: messageId, ...(resolved.target.kind === 'session' ? { sourceTaskRunId: resolved.target.taskRunId } : {}) } };
}
