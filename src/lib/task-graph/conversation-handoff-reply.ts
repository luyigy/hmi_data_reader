import type { Prisma, TaskRun, TaskRunParticipant } from '@prisma/client';

const prefix = 'conversation-material-handoff:';

/** Presentation follows the already-authorized handoff; it never admits execution. */
export async function inheritConversationReply(tx: Prisma.TransactionClient, taskRunId: string, executionId: string, epoch?: string) {
  if (!epoch?.startsWith(prefix)) return false;
  const reservationId = epoch.slice(prefix.length);
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
  const binding = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
    runId: job.node.runId, idempotencyKey: `conversation-followup:${reservationId}:run` } } });
  const value = binding?.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.executionId !== job.id || typeof value.taskRunId !== 'string')
    throw new Error('Conversation handoff reply source is missing');
  const source = await tx.taskRun.findUniqueOrThrow({ where: { id: value.taskRunId }, include: { participants: true } });
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const metadata = JSON.parse(source.controlMetadata || '{}');
  const identity = metadata.graphReplyIdentity;
  const owners = (participants: TaskRunParticipant[]) => participants.map(p => [p.role, p.executionBackend, p.harnessType, p.gatewayId, p.agentId]).sort();
  if (source.taskId !== job.childTaskId || source.taskId !== run.taskId || !source.taskSessionId || source.taskSessionId !== run.taskSessionId ||
    metadata.graphConversation?.executionId !== job.id || metadata.graphConversation?.reservationId !== reservationId ||
    source.participants.some(p => p.role !== 'implementer') || !source.participants.length ||
    JSON.stringify(owners(source.participants)) !== JSON.stringify(owners(run.participants)) ||
    typeof identity !== 'string' || !/^conversation:[a-f0-9]{64}$/.test(identity)) throw new Error('Conversation handoff reply owner changed');
  await tx.taskRun.update({ where: { id: run.id }, data: { controlMetadata: JSON.stringify({
    ...JSON.parse(run.controlMetadata || '{}'), graphReplyIdentity: identity }) } });
  return true;
}

/** A native read-only turn can finish while the user's request is still being handed over. */
export async function conversationHandoffPending(tx: Prisma.TransactionClient, run: TaskRun & { participants: TaskRunParticipant[] }) {
  const metadata = JSON.parse(run.controlMetadata || '{}').graphConversation;
  if (!metadata || run.status !== 'completed') return false;
  const summary = run.participants[0]?.summary || run.summary || '';
  const matches = Array.from(summary.matchAll(/^TASK_GRAPH_CONVERSATION\s+(\{[^\n]+\})\s*$/gm));
  if (matches.length !== 1) return false;
  try { if (JSON.parse(matches[0][1]).action !== 'resume_implementation') return false; } catch { return false; }
  const job = await tx.taskGraphExecution.findUnique({ where: { id: metadata.executionId }, include: { node: true } });
  if (!job || job.childTaskId !== run.taskId) return false;
  const finished = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
    runId: job.node.runId, idempotencyKey: `conversation-followup:${metadata.reservationId}:finished` } } });
  if (!finished) return true;
  const raw = job.dispatchMetadata;
  const progress = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.progress : null;
  return !!progress && typeof progress === 'object' && !Array.isArray(progress) &&
    progress.replyEpoch === prefix + metadata.reservationId && ['ready', 'claimed'].includes(job.status);
}
