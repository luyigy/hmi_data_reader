import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../redact-sensitive';
import { completedReplyParagraphs } from './run-reply-progress';
import { prisma } from '../prisma';
import { replyFeishuMessage, sendFeishuInteractiveMessage } from '../feishu-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { buildRunReplyCard, buildRunAgentReplyCard } from './run-reply-card';

async function runBinding(taskId: string) {
  const direct = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: taskId }, rootMessageId: { not: null } }, orderBy: { updatedAt: 'desc' },
  });
  if (direct) return direct;
  const review = taskId.match(/^task-graph-(?:review|architecture)-(.+)$/);
  if (!review) return null;
  const node = await prisma.taskGraphNode.findUnique({ where: { id: review[1] }, include: { executions: true } });
  const childIds = node?.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : []) || [];
  return prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: { in: childIds } }, rootMessageId: { not: null } }, orderBy: { createdAt: 'asc' },
  });
}

/** Relay persisted events, including history, without coupling delivery to the running harness. */
export async function relayTaskGraphRunReply(taskRunId: string) {
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  if (!run.taskId.startsWith('task-graph-')) return false;
  const binding = await runBinding(run.taskId);
  if (!binding?.rootMessageId) return false;
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
    if (cursor.deliveredSequence === sequence && cursor.lastStatus === run.status && !expiredSinceDelivery) return false;
    if (!cursor.messageId && Date.now() - cursor.createdAt.getTime() > 50 * 60_000) {
      throw new Error(`Reply receipt uncertain for ${run.id}; reconcile before resending`);
    }
    const output = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: 'stdout_chunk' }, orderBy: { sequence: 'desc' }, take: 1000 });
    const history = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: { notIn: ['stdout_chunk', 'stderr_chunk', 'summary'] } }, orderBy: { sequence: 'desc' }, take: 100 });
    output.reverse();
    const card = buildRunReplyCard(run, history.reverse(), requests);
    let messageId = cursor.messageId;
    if (messageId) await updateFeishuTaskEntryCard(messageId, card);
    else messageId = await sendFeishuInteractiveMessage({ receiveId: binding.chatId, threadRootMessageId: rootMessageId,
      uuid: `graph-run-reply-${run.id}`, card }) || null;
    if (!messageId) throw new Error('Reply card send returned no message id');
    const identity = run.participants.map((participant) => participant.harnessNameSnapshot || participant.harnessType || participant.runner).join(' / ') || 'Harness';
    const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(run.status);
    const notices = terminal
      ? cursor.lastStatus === run.status ? [] : [{
        key: `terminal-${run.status}`,
        text: `${run.status === 'completed' ? '会话结束' : '执行结束（未成功）'}\n\n` +
          (run.participants.map((participant) => participant.summary || participant.error || '').filter(Boolean).join('\n\n') || run.summary || run.error || '无最终回复。') +
          '\n\n会话结束不代表 Slice 验收通过；集成和验收状态以路线进度为准。',
      }]
      : completedReplyParagraphs(output, cursor.deliveredSequence).map((paragraph) => ({
        key: `progress-${paragraph.sequence}-${createHash('sha256').update(paragraph.text).digest('hex').slice(0, 16)}`,
        text: paragraph.text,
      }));
    for (const notice of notices) {
      await replyFeishuMessage({ messageId: rootMessageId, msgType: 'interactive',
        content: buildRunAgentReplyCard(identity, redactSensitiveText(notice.text)), replyInThread: true,
        uuid: `graph-note-${createHash('sha256').update(`${run.id}:${notice.key}`).digest('hex').slice(0, 32)}` });
    }
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
