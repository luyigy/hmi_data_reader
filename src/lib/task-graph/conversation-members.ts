import { prisma } from '../prisma';
import type { AcpxParticipantRequest } from '../acpx/types';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse the approved launch snapshot without depending on today's mutable catalog. */
export function approvedConversationParticipant(config: unknown): AcpxParticipantRequest {
  const value = record(config) ? config.participant : null;
  if (!record(value) || value.executionBackend !== 'platform_local' ||
      typeof value.gatewayId !== 'string' || typeof value.harnessType !== 'string' || typeof value.role !== 'string') {
    throw new Error('Approved graph participant is missing or unsupported');
  }
  return {
    gatewayId: value.gatewayId, executionBackend: value.executionBackend, harnessType: value.harnessType, role: value.role,
    agentId: typeof value.agentId === 'string' ? value.agentId : undefined,
    agentName: typeof value.agentName === 'string' ? value.agentName : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined,
  };
}

/** A graph child topic is a real conversation, not just a destination for event copies. */
export async function ensureGraphRoomParticipants(roomId: string, executionId: string) {
  const execution = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: { include: { run: true } } } });
  const snapshot = execution.node.run.snapshot;
  if (!record(snapshot) || !Array.isArray(snapshot.nodes)) throw new Error('Graph snapshot missing');
  const node = snapshot.nodes.find((value) => record(value) && value.key === execution.node.key);
  if (!record(node) || !record(node.acceptance)) throw new Error('Graph node missing');
  const participants = [approvedConversationParticipant(execution.launchConfig)];
  if (node.acceptance.mode === 'agent') participants.push(approvedConversationParticipant(node.acceptance.reviewLaunchConfig));
  const architecture = node.architectureReview || snapshot.defaultArchitectureReview;
  if (node.executionMode !== 'lean' && node.executionMode !== 'implement' && record(architecture)) {
    participants.push(approvedConversationParticipant(architecture.reviewLaunchConfig));
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LiveRoom" WHERE id = ${roomId} FOR UPDATE`;
    const room = await tx.liveRoom.findUniqueOrThrow({ where: { id: roomId }, include: { sourceTask: true, members: true } });
    if (!execution.childTaskId || room.sourceTaskId !== execution.childTaskId) throw new Error('Graph conversation belongs to another execution');
    const members = [...room.members];
    for (const approved of participants) {
      const existing = members.find((member) => member.backend === approved.executionBackend && member.harnessType === approved.harnessType &&
        member.runtimeAgentId === (approved.agentId || null));
      if (existing) continue; // Explicitly removed/stopped members are not silently re-enabled.
      const member = await tx.liveRoomMember.create({ data: {
        roomId, memberType: 'local_agent', backend: approved.executionBackend, harnessType: approved.harnessType,
        runtimeAgentId: approved.agentId || null, displayName: approved.agentName || approved.harnessType,
        agentNameSnapshot: approved.agentName || approved.harnessType, role: approved.role,
        roleLabel: '任务图获批参与者', canReply: true, joinStatus: 'joined', presenceStatus: 'idle', sortOrder: members.length + 1,
        codexModel: approved.model || null, codexReasoningEffort: approved.reasoningEffort || null,
        acpxPermissionConfig: JSON.stringify(taskGraphAgentReviewPermissionConfig),
      } });
      members.push(member);
    }
    await tx.liveRoom.update({ where: { id: roomId }, data: {
      currentSpeakerMemberId: room.currentSpeakerMemberId || members.find((member) => member.canReply && member.joinStatus === 'joined')?.id,
      ownerUserId: room.ownerUserId || room.sourceTask?.ownerUserId,
    } });
    return members;
  });
}

/** Repair legacy graph rooms before resolving an inbound question. */
export async function ensureGraphConversationMembers(roomId: string) {
  const room = await prisma.liveRoom.findUnique({ where: { id: roomId }, select: { sourceTaskId: true } });
  if (!room?.sourceTaskId) return;
  const execution = await prisma.taskGraphExecution.findFirst({ where: { childTaskId: room.sourceTaskId }, select: { id: true } });
  if (execution) await ensureGraphRoomParticipants(roomId, execution.id);
}
