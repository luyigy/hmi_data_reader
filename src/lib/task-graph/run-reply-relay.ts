import { prisma } from '../prisma';
import { buildRunReplyCard } from './run-reply-card';
import { deliverProgressCard } from './progress-card-delivery';
import { executionProgress } from './execution-progress';

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
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-reply-topic:${binding.id}`})) AS locked`;
    if (!lock.locked) return false;
    const cursor = await tx.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } });
    if (cursor.bindingId !== binding.id) throw new Error(`Reply target changed for ${run.id}; reconcile the original card`);
    const newest = await tx.taskRunFeishuRelay.findFirstOrThrow({ where: { bindingId: binding.id },
      orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }] });
    if (newest.taskRunId !== run.id) {
      await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id }, data: { lastStatus: 'superseded' } });
      return false;
    }
    const first = await tx.taskRunFeishuRelay.findFirstOrThrow({ where: { bindingId: binding.id },
      orderBy: [{ createdAt: 'asc' }, { taskRunId: 'asc' }] });
    const existingCard = await tx.taskRunFeishuRelay.findFirst({ where: { bindingId: binding.id, messageId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { taskRunId: 'asc' }] });
    const latest = await tx.taskRunEvent.findFirst({ where: { taskRunId: run.id }, orderBy: { sequence: 'desc' } });
    const sequence = latest?.sequence || 0;
    const requests = await tx.taskRunInteractionRequest.findMany({ where: { taskRunId: run.id, status: 'pending' } });
    const expiredSinceDelivery = requests.some((request) => request.expiresAt && request.expiresAt <= new Date() && request.expiresAt > cursor.updatedAt);
    const execution = await tx.taskGraphExecution.findFirst({ where: { childTask: { liveRooms: { some: { id: binding.liveRoomId } } } },
      select: { childTaskId: true, dispatchMetadata: true, updatedAt: true, node: { select: { runId: true, status: true, updatedAt: true } } } });
    const graphChanged = execution && (execution.updatedAt > cursor.updatedAt || execution.node.updatedAt > cursor.updatedAt);
    if (!forceRefresh && !graphChanged && cursor.deliveredSequence === sequence && cursor.lastStatus === run.status && !expiredSinceDelivery) return false;
    const output = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: 'stdout_chunk' }, orderBy: { sequence: 'desc' }, take: 1000 });
    const history = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: { notIn: ['stdout_chunk', 'stderr_chunk', 'summary'] } }, orderBy: { sequence: 'desc' }, take: 100 });
    output.reverse();
    const card = buildRunReplyCard({ ...run, graphStatus: execution?.node.status, graphProgress: executionProgress(execution?.dispatchMetadata) }, history.reverse(), requests, output);
    card.header.title.content = `${run.task.name} · ${card.header.title.content}`;
    const messageId = await deliverProgressCard({ bindingId: binding.id, runId: execution?.node.runId,
      childTaskId: execution?.childTaskId || undefined, chatId: binding.chatId, rootMessageId, card,
      messageId: existingCard?.messageId || cursor.messageId, firstRun: first });
    if (!messageId) throw new Error('Reply card send returned no message id');
    await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id },
      data: { messageId, deliveredSequence: sequence, lastStatus: run.status } });
    return true;
  }, { timeout: 25_000 });
}

export async function relayTaskGraphReplies() {
  const runs = await prisma.taskRun.findMany({ where: { taskId: { startsWith: 'task-graph-' },
    NOT: { feishuRelay: { lastStatus: 'superseded' } },
    OR: [{ feishuRelay: null }, { status: { in: ['running', 'waiting_for_input', 'pending'] } },
      { feishuRelay: { lastStatus: { notIn: ['completed', 'failed', 'stopped', 'interrupted'] } } },
      { completedAt: { gte: new Date(Date.now() - 5 * 60_000) } }] },
    orderBy: { createdAt: 'asc' }, select: { id: true }, take: 100 });
  for (const run of runs) {
    try { await relayTaskGraphRunReply(run.id); }
    catch (error) { console.error('[TaskGraphReplies] delivery failed', { taskRunId: run.id, error: error instanceof Error ? error.message : String(error) }); }
  }
}
