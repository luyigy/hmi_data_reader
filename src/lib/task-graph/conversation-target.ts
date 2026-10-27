import { resetConversationTarget, conversationTargetWasReset } from './conversation-reset';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { getContinuationSession } from '../acpx/session-tracking';
import { executionProgress } from './execution-progress';

export type ConversationTarget =
  | { kind: 'session'; role: string; taskId: string; taskSessionId: string; taskRunId: string; nativeSessionId: string | null; candidateCommit: string | null; resetSourceSessionId?: string }
  | { kind: 'implementation'; role: 'implementer'; taskId: string; resetSourceSessionId?: string }
  | { kind: 'unresolved'; reason: string };

export function parseConversationTarget(value: unknown): ConversationTarget | undefined {
  if (value === undefined) return undefined; // Historical inputs retain their original implementation routing.
  if (!value || typeof value !== 'object') return { kind: 'unresolved', reason: '消息接收会话记录无效。' };
  const t = value as Record<string, unknown>;
  if (t.kind === 'unresolved' && typeof t.reason === 'string') return { kind: 'unresolved', reason: t.reason };
  if (t.kind === 'implementation' && t.role === 'implementer' && typeof t.taskId === 'string') return { kind: t.kind, role: t.role, taskId: t.taskId, ...(typeof t.resetSourceSessionId === 'string' ? { resetSourceSessionId: t.resetSourceSessionId } : {}) };
  if (t.kind === 'session' && typeof t.role === 'string' && typeof t.taskId === 'string' && typeof t.taskSessionId === 'string' && typeof t.taskRunId === 'string' &&
    (t.nativeSessionId === null || typeof t.nativeSessionId === 'string') && (t.candidateCommit === null || typeof t.candidateCommit === 'string')) {
    return { kind: t.kind, role: t.role, taskId: t.taskId, taskSessionId: t.taskSessionId, taskRunId: t.taskRunId, nativeSessionId: t.nativeSessionId, candidateCommit: t.candidateCommit, ...(typeof t.resetSourceSessionId === 'string' ? { resetSourceSessionId: t.resetSourceSessionId } : {}) };
  }
  return { kind: 'unresolved', reason: '消息接收会话记录不完整，不能改送其他 Agent。' };
}

function metadata(text?: string | null): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

/** Resolve once under the node lock. A card identifies a session, not the current phase. */
export async function resolveConversationTarget(tx: Prisma.TransactionClient, job: TaskGraphExecution,
  sourceMetadata?: string | null): Promise<ConversationTarget> {
  const source = metadata(sourceMetadata);
  if (!job.childTaskId) return { kind: 'unresolved', reason: '任务会话尚未建立。' };
  const room = await tx.liveRoom.findFirst({ where: { sourceTaskId: job.childTaskId }, include: { members: true } });
  const allowedTasks = [job.childTaskId, `task-graph-review-${job.nodeId}`, `task-graph-architecture-${job.nodeId}`].filter((id): id is string => Boolean(id));
  const fromRun = async (id: string, role?: string): Promise<ConversationTarget> => {
    const run = await tx.taskRun.findUnique({ where: { id }, include: { participants: true } });
    if (!run || !allowedTasks.includes(run.taskId) || !run.taskSessionId) return { kind: 'unresolved', reason: '这张卡片的原会话身份不可用，请回复明确的执行者或验收者卡片。' };
    const participants = run.participants.filter(p => !role || p.role === role);
    if (participants.length !== 1) return { kind: 'unresolved', reason: '请明确消息发给执行者还是验收者。' };
    const participant = participants[0];
    const review = executionProgress(job.dispatchMetadata)?.review;
    const candidateCommit = participant.role === 'implementer' ? null : reviewCandidate(run.controlMetadata, job.id) ||
      (review?.kind === 'running' && review.taskRunId === run.id ? review.candidateCommit : null);
    if (participant.role !== 'implementer' && !candidateCommit) return { kind: 'unresolved', reason: '这张历史复核卡片的固定候选记录不可用，不能改送当前验收者。' };
    return resetConversationTarget(tx, job, { kind: 'session', role: participant.role, taskId: run.taskId, taskRunId: run.id, taskSessionId: run.taskSessionId,
      nativeSessionId: getContinuationSession(participant).sessionId || (typeof metadata(participant.controlMetadata).resumeSessionId === 'string' ? String(metadata(participant.controlMetadata).resumeSessionId) : null),
      candidateCommit });
  };
  if (typeof source.feishuParentMessageId === 'string' && room) {
    const binding = await tx.feishuConversationBinding.findFirst({ where: { liveRoomId: room.id,
      ...(typeof source.feishuBindingId === 'string' ? { id: source.feishuBindingId } : {}) } });
    if (!binding) return { kind: 'unresolved', reason: '回复的话题绑定已改变，请回复本任务的角色卡片。' };
    if (source.feishuParentMessageId !== binding.rootMessageId) {
      const relay = await tx.taskRunFeishuRelay.findFirst({ where: { bindingId: binding.id, messageId: source.feishuParentMessageId }, orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }] });
      if (!relay) {
        const receipt = await tx.taskGraphEvent.findFirst({ where: { nodeId: job.nodeId, kind: 'conversation_reply_card',
          AND: [{ payload: { path: ['bindingId'], equals: binding.id } }, { payload: { path: ['messageId'], equals: source.feishuParentMessageId } }] } });
        const value = receipt?.payload;
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.taskRunId === 'string') return fromRun(value.taskRunId);
      }
      if (!relay) return { kind: 'unresolved', reason: '无法确认被回复消息的 Agent 会话，请回复执行者或验收者的运行卡片。' };
      return fromRun(relay.taskRunId);
    }
  }
  const explicit = source.targetLocked === true || Array.isArray(source.mentionedMemberIds) && source.mentionedMemberIds.length > 0;
  if (explicit && room) {
    const ids = Array.isArray(source.mentionedMemberIds) && source.mentionedMemberIds.length ? source.mentionedMemberIds : [source.primaryTargetMemberId];
    const members = room.members.filter(m => ids.includes(m.id) && m.canReply && m.joinStatus === 'joined');
    if (members.length !== 1) return { kind: 'unresolved', reason: '同一模型有多个角色，请回复具体执行者或验收者的卡片。' };
    const member = members[0];
    const taskId = member.role === 'implementer' ? job.childTaskId : member.role === 'tester' ? `task-graph-review-${job.nodeId}` : `task-graph-architecture-${job.nodeId}`;
    const run = await tx.taskRun.findFirst({ where: { taskId: taskId || '', participants: { some: { role: member.role, harnessType: member.harnessType || '', agentId: member.runtimeAgentId } } }, orderBy: { createdAt: 'desc' } });
    if (run) return fromRun(run.id, member.role);
    return member.role === 'implementer' && job.childTaskId ? resetConversationTarget(tx, job, { kind: 'implementation', role: 'implementer', taskId: job.childTaskId })
      : { kind: 'unresolved', reason: '这个角色还没有可接续的会话，不能改送其他角色。' };
  }
  const progress = executionProgress(job.dispatchMetadata);
  const role = progress?.phase === 'acceptance' ? 'tester' : progress?.phase === 'architecture' ? 'reviewer' : 'implementer';
  if (role !== 'implementer') {
    const taskId = role === 'tester' ? `task-graph-review-${job.nodeId}` : `task-graph-architecture-${job.nodeId}`;
    const run = await tx.taskRun.findFirst({ where: { taskId, participants: { some: { role } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return run ? fromRun(run.id, role) : { kind: 'unresolved', reason: '当前阶段的复核会话尚未建立，不能改送实施者。' };
  }
  const owner = progress?.conversationOwnerRunId || progress?.taskRunId || job.taskRunId;
  if (owner) return fromRun(owner, 'implementer');
  return resetConversationTarget(tx, job, { kind: 'implementation', role: 'implementer', taskId: job.childTaskId! });
}

export const isImplementationInput = (input: { target?: ConversationTarget }) => !input.target || input.target.kind === 'implementation' || input.target.kind === 'session' && input.target.role === 'implementer';
export const conversationTargetKey = (target?: ConversationTarget) => target?.kind === 'session'
  ? JSON.stringify([target.taskId, target.role, target.taskSessionId, target.nativeSessionId, target.candidateCommit]) : JSON.stringify(target || null);

export async function assertConversationTargetRun(tx: Prisma.TransactionClient, target: ConversationTarget | undefined, taskRunId: string, executionId?: string) {
  if (!target) return;
  if (target.kind === 'unresolved') throw new Error(target.reason);
  const job = executionId ? await tx.taskGraphExecution.findUnique({ where: { id: executionId } }) : await tx.taskGraphExecution.findFirst({ where: { OR: [{ childTaskId: target.taskId }, ...(target.kind === 'session' && target.role !== 'implementer' ? [{ nodeId: target.taskId.replace(/^task-graph-(review|architecture)-/, '') }] : [])] } });
  if (job && await conversationTargetWasReset(tx, job, target)) throw new Error('Conversation reset superseded this queued input');
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  if (run.taskId !== target.taskId || !run.participants.some(p => p.role === target.role) ||
      target.kind === 'session' && run.taskSessionId !== target.taskSessionId) throw new Error('Conversation target session changed; input cannot be rerouted');
  if (target.kind === 'session') {
    let expected = target.nativeSessionId;
    if (!expected && !target.resetSourceSessionId && run.id !== target.taskRunId) {
      const original = await tx.taskRunParticipant.findFirst({ where: { taskRunId: target.taskRunId, role: target.role } });
      if (!original) throw new Error('Original conversation participant unavailable');
      expected = getContinuationSession(original).sessionId || (typeof metadata(original.controlMetadata).resumeSessionId === 'string' ? String(metadata(original.controlMetadata).resumeSessionId) : null);
    }
    const participant = run.participants.find(p => p.role === target.role)!;
    const saved = getContinuationSession(participant).sessionId || metadata(participant.controlMetadata).resumeSessionId;
    if (expected && saved !== expected) throw new Error('Conversation native session changed; input cannot be rerouted');
  }
}

function reviewCandidate(raw: string | null, executionId: string) {
  const candidates = metadata(raw).reviewCandidates;
  if (!Array.isArray(candidates)) return null;
  const candidate = candidates.find(item => item?.id === executionId);
  return typeof candidate?.commit === 'string' ? candidate.commit : null;
}
