import { prisma } from '../prisma';
import { getContinuationSession } from '../acpx/session-tracking';
import { approvedConversationParticipant } from './conversation-members';
import { implementationConversation } from './conversation-session';
import type { ConversationTarget } from './conversation-target';

/** A queued reply resumes its captured participant, never the latest participant of a role. */
export async function conversationContinuation(executionId: string, target?: ConversationTarget) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: { include: { run: true } } } });
  if (!target || target.kind === 'implementation') {
    return { ...await implementationConversation(executionId, approvedConversationParticipant(job.launchConfig)), taskId: job.childTaskId!, workingDirectory: job.worktreePath, extraReadOnlyPaths: [] as string[] };
  }
  if (target.kind === 'unresolved') throw new Error(target.reason);
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: target.taskRunId }, include: { participants: true } });
  if (run.taskId !== target.taskId || run.taskSessionId !== target.taskSessionId) throw new Error('Original conversation identity changed');
  const original = run.participants.find(p => p.role === target.role);
  if (!original) throw new Error('Original conversation participant unavailable');
  let native = getContinuationSession(original);
  if (!native.sessionId && ['failed', 'interrupted', 'stopped'].includes(run.status)) {
    const requested = JSON.parse(original.controlMetadata || '{}').resumeSessionId;
    if (typeof requested === 'string' && requested === target.nativeSessionId) {
      const history = await prisma.taskRunParticipant.findMany({ where: {
        role: original.role, harnessType: original.harnessType, executionBackend: original.executionBackend,
        gatewayId: original.gatewayId, agentId: original.agentId,
        taskRun: { taskId: run.taskId, taskSessionId: run.taskSessionId, createdAt: { lt: run.createdAt } },
      }, orderBy: { taskRun: { createdAt: 'desc' } } });
      const prior = history.map(getContinuationSession).find(session => session.sessionId === requested);
      if (prior) native = prior;
    }
  }
  if (!native.sessionId || target.nativeSessionId && native.sessionId !== target.nativeSessionId) throw new Error('原生会话身份不可用；消息已保留，不能改送新会话。');
  const snapshot = job.node.run.snapshot;
  const nodes = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot.nodes : null;
  const node = Array.isArray(nodes) ? nodes.find(n => n && typeof n === 'object' && !Array.isArray(n) && n.key === job.node.key) : null;
  const definition = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
  const gate = target.role === 'tester' ? definition.acceptance : definition.architectureReview ||
    (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot.defaultArchitectureReview : null);
  const config = target.role === 'implementer' ? job.launchConfig : gate && typeof gate === 'object' && !Array.isArray(gate) ? gate.reviewLaunchConfig : null;
  const approved = approvedConversationParticipant(config);
  if (approved.role !== original.role || approved.harnessType !== original.harnessType || approved.executionBackend !== original.executionBackend ||
    (approved.agentId || null) !== original.agentId || approved.gatewayId !== original.gatewayId) throw new Error('Original conversation no longer matches its approved participant');
  const start = await prisma.taskRunEvent.findFirst({ where: { taskRunId: run.id, eventType: 'runner_started' }, orderBy: { sequence: 'asc' } });
  let workingDirectory: string | null = null;
  let extraReadOnlyPaths: string[] = [];
  try { const data = JSON.parse(start?.metadata || '{}'); if (typeof data.workingDirectory === 'string') workingDirectory = data.workingDirectory;
    if (Array.isArray(data.extraReadOnlyPaths) && data.extraReadOnlyPaths.every((p: unknown) => typeof p === 'string')) extraReadOnlyPaths = data.extraReadOnlyPaths; } catch { /* Missing evidence must not invent a new workspace. */ }
  if (!workingDirectory) throw new Error('原会话工作区记录不可用；消息已保留，不能切换到其他工作区。');
  return { taskId: target.taskId, taskSessionId: target.taskSessionId, workingDirectory, extraReadOnlyPaths, context: '',
    participant: { ...approved, resumeSessionId: native.sessionId, continuationSessionKind: native.sessionKind || undefined,
      ...(native.sessionKind === 'codex_thread' ? { resumeThreadId: native.sessionId } : {}) } };
}
