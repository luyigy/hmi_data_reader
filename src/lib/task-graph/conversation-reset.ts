import { createHash } from 'node:crypto';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { parseTaskSessionMetadata } from '../acpx/session';
import { approvedConversationParticipant } from './conversation-members';
import { getContinuationSession } from '../acpx/session-tracking';
import type { ConversationTarget } from './conversation-target';

type Participant = { role: string; harnessType: string; executionBackend: string; agentId?: string | null; gatewayId: string | null };

/** The child room owns rotation intent; each role keeps its own Task and platform Session. */
export async function graphConversationReset(tx: Prisma.TransactionClient, job: TaskGraphExecution, participant: Participant, taskId: string, candidateCommit?: string | null) {
  if (!job.childTaskId) return null;
  const members = await tx.liveRoomMember.findMany({ where: { room: { sourceTaskId: job.childTaskId }, role: participant.role,
    backend: participant.executionBackend, harnessType: participant.harnessType, runtimeAgentId: participant.agentId || null, ...(participant.executionBackend === 'platform_local' ? {} : { gatewayId: participant.gatewayId }) } });
  const sessions = await tx.taskSession.findMany({ where: { taskId: job.childTaskId, metadata: { contains: 'feishu_new_session' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  for (const source of sessions) {
    const metadata = parseTaskSessionMetadata(source.metadata);
    if (metadata.source !== 'feishu_new_session') continue;
    const ids = Array.isArray(metadata.targetMemberIds) ? metadata.targetMemberIds : typeof metadata.targetMemberId === 'string' ? [metadata.targetMemberId] : null;
    if (ids && !members.some(member => ids.includes(member.id))) continue;
    if (metadata.rotationCheckpoint !== 'completed') throw new Error('Conversation reset is still in progress');
    if (taskId === job.childTaskId) return { id: source.id, sourceId: source.id };
    const id = 'graph-reset-' + createHash('sha256').update(JSON.stringify([source.id, taskId, participant.role, participant.harnessType, participant.agentId || null, candidateCommit || null])).digest('hex');
    await tx.taskSession.upsert({ where: { id }, update: {}, create: { id, taskId, status: 'active', attentionState: 'normal',
      metadata: JSON.stringify({ source: 'graph_conversation_reset', sourceSessionId: source.id }) } });
    return { id, sourceId: source.id };
  }
  return null;
}

async function implementationReset(tx: Prisma.TransactionClient, job: TaskGraphExecution) {
  if (!job.childTaskId || !await tx.taskSession.findFirst({ where: { taskId: job.childTaskId, metadata: { contains: 'feishu_new_session' } }, select: { id: true } })) return null;
  return graphConversationReset(tx, job, approvedConversationParticipant(job.launchConfig), job.childTaskId);
}

/** Apply a reset to a newly received message, including a reply to an old role card. */
export async function resetConversationTarget(tx: Prisma.TransactionClient, job: TaskGraphExecution, target: ConversationTarget): Promise<ConversationTarget> {
  if (target.kind === 'unresolved') return target;
  if (target.kind === 'implementation') {
    const reset = await implementationReset(tx, job);
    return reset ? { ...target, resetSourceSessionId: reset.sourceId } : target;
  }
  const original = await tx.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: target.taskRunId, role: target.role } });
  const reset = await graphConversationReset(tx, job, original, target.taskId, target.candidateCommit);
  if (!reset) return target;
  const latest = await tx.taskRun.findFirst({ where: { taskId: target.taskId, taskSessionId: reset.id,
    participants: { some: { role: original.role, harnessType: original.harnessType, executionBackend: original.executionBackend, agentId: original.agentId } } },
    include: { participants: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const participant = latest?.participants.find(p => p.role === original.role);
  const metadata = parseTaskSessionMetadata(participant?.controlMetadata);
  return { ...target, taskSessionId: reset.id, resetSourceSessionId: reset.sourceId,
    taskRunId: latest?.id || target.taskRunId,
    nativeSessionId: participant ? getContinuationSession(participant).sessionId || (typeof metadata.resumeSessionId === 'string' ? metadata.resumeSessionId : null) : null };
}

/** Captured pre-reset input is cancelled, never silently rebound or steered into either session. */
export async function conversationTargetWasReset(tx: Prisma.TransactionClient, job: TaskGraphExecution, target?: ConversationTarget) {
  if (target?.kind === 'unresolved') return false;
  if (!target || target.kind === 'implementation') {
    if (!job.childTaskId) return false;
    const reset = await implementationReset(tx, job);
    return !!reset && target?.resetSourceSessionId !== reset.sourceId;
  }
  const original = await tx.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: target.taskRunId, role: target.role } });
  const reset = await graphConversationReset(tx, job, original, target.taskId, target.candidateCommit);
  return !!reset && (target.taskSessionId !== reset.id || target.resetSourceSessionId !== reset.sourceId);
}

/** Recheck even when there are no user input IDs (automatic retry/continuation). */
export async function assertGraphConversationRunSession(tx: Prisma.TransactionClient, job: TaskGraphExecution, taskRunId: string) {
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  for (const participant of run.participants) {
    if (participant.role !== 'implementer') continue; // Read-only role turns validate their captured candidate/session below.
    const reset = await graphConversationReset(tx, job, participant, run.taskId);
    if (reset && run.taskSessionId !== reset.id) throw new Error('Conversation reset superseded this TaskRun session');
  }
}

export async function assertGraphResetComplete(tx: Prisma.TransactionClient, executionIds: string[], participants: Participant[]) {
  for (const id of executionIds) {
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id } });
    for (const participant of participants) await graphConversationReset(tx, job, participant, job.childTaskId!);
  }
}
