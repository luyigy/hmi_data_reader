import { prisma } from '../prisma';
import { createHash } from 'node:crypto';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { buildRunReplyCard } from './run-reply-card';

async function runBinding(taskId: string) {
  const direct = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: taskId }, chatType: 'group', rootMessageId: { not: null } }, orderBy: { updatedAt: 'desc' },
  });
  if (direct) return direct;
  const review = taskId.match(/^task-graph-(?:review|architecture)-(.+)$/);
  const node = review
    ? await prisma.taskGraphNode.findUnique({ where: { id: review[1] }, include: { executions: true, run: true } })
    : (await prisma.taskGraphExecution.findUnique({ where: { childTaskId: taskId },
      include: { node: { include: { executions: true, run: true } } } }))?.node;
  if (!node) return null;
  const childIds = node.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : []);
  if (review) {
    const child = await prisma.feishuConversationBinding.findFirst({
      where: { liveRoom: { sourceTaskId: { in: childIds } }, chatType: 'group', rootMessageId: { not: null } }, orderBy: { createdAt: 'asc' },
    });
    if (child) return child;
  }
  return null;
}

/** Relay persisted events, including history, without coupling delivery to the running harness. */
export async function relayTaskGraphRunReply(taskRunId: string, forceRefresh = false) {
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId },
    include: { participants: true, task: { select: { name: true } } } });
  if (!run.taskId.startsWith('task-graph-')) return false;
  const binding = await runBinding(run.taskId);
  if (!binding) return false;
  const rootMessageId = binding.rootMessageId;
  await prisma.taskRunFeishuRelay.upsert({ where: { taskRunId: run.id },
    create: { taskRunId: run.id, bindingId: binding.id }, update: {} });
  return prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-reply:${run.id}`})) AS locked`;
    if (!lock.locked) return false;
    const cursor = await tx.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } });
    if (cursor.bindingId !== binding.id) throw new Error(`Reply target changed for ${run.id}; reconcile the original card`);
    const latest = await tx.taskRunEvent.findFirst({ where: { taskRunId: run.id }, orderBy: { sequence: 'desc' } });
    const sequence = latest?.sequence || 0;
    const requests = await tx.taskRunInteractionRequest.findMany({ where: { taskRunId: run.id, status: 'pending' } });
    const expiredSinceDelivery = requests.some((request) => request.expiresAt && request.expiresAt <= new Date() && request.expiresAt > cursor.updatedAt);
    const execution = await tx.taskGraphExecution.findUnique({ where: { childTaskId: run.taskId }, select: { node: { select: { status: true, updatedAt: true } } } });
    const graphChanged = execution && execution.node.updatedAt > cursor.updatedAt;
    if (!forceRefresh && !graphChanged && cursor.deliveredSequence === sequence && cursor.lastStatus === run.status && !expiredSinceDelivery) return false;
    if (!cursor.messageId && Date.now() - cursor.createdAt.getTime() > 50 * 60_000) {
      throw new Error(`Reply receipt uncertain for ${run.id}; reconcile before resending`);
    }
    const output = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: 'stdout_chunk' }, orderBy: { sequence: 'desc' }, take: 1000 });
    const history = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: { notIn: ['stdout_chunk', 'stderr_chunk', 'summary'] } }, orderBy: { sequence: 'desc' }, take: 100 });
    output.reverse();
    const card = buildRunReplyCard({ ...run, graphStatus: execution?.node.status }, history.reverse(), requests, output);
    card.header.title.content = `${run.task.name} · ${card.header.title.content}`;
    let messageId = cursor.messageId;
    if (messageId) await updateFeishuTaskEntryCard(messageId, card);
    else messageId = await sendFeishuInteractiveMessage({ receiveId: binding.chatId,
      ...(rootMessageId ? { threadRootMessageId: rootMessageId } : {}),
      uuid: createHash('sha256').update(`graph-reply:${run.id}:${binding.id}`).digest('hex').slice(0, 48), card }) || null;
    if (!messageId) throw new Error('Reply card send returned no message id');
    await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id },
      data: { messageId, deliveredSequence: sequence, lastStatus: run.status } });
    return true;
  }, { timeout: 25_000 });
}

export async function relayTaskGraphReplies() {
  const runs = await prisma.taskRun.findMany({ where: { taskId: { startsWith: 'task-graph-' },
    OR: [{ feishuRelay: null }, { status: { in: ['running', 'waiting_for_input', 'pending'] } },
      { feishuRelay: { lastStatus: { notIn: ['completed', 'failed', 'stopped', 'interrupted'] } } },
      { completedAt: { gte: new Date(Date.now() - 5 * 60_000) } }] },
    orderBy: { createdAt: 'asc' }, select: { id: true }, take: 100 });
  for (const run of runs) {
    try { await relayTaskGraphRunReply(run.id); }
    catch (error) { console.error('[TaskGraphReplies] delivery failed', { taskRunId: run.id, error: error instanceof Error ? error.message : String(error) }); }
  }
}
