import { conversationHandoffPending } from './conversation-handoff-reply';
import { conversationReplyOwner } from './conversation-reply-identity';
import { deliverRunReplyImages } from './reply-images';
import { queueGraphNotification } from './notifications';
import { redactSensitiveText } from '../redact-sensitive';
import { prisma } from '../prisma';
import { buildRunReplyCard } from './run-reply-card';
import { readSessionSize } from '../session-size';
import { deliverProgressCard } from './progress-card-delivery';
import { graphNodeForTask } from './task-binding';

export async function runBinding(taskId: string) {
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
  if (!await graphNodeForTask(run.taskId)) return false;
  const binding = await runBinding(run.taskId);
  if (!binding) return false;
  const rootMessageId = binding.rootMessageId;
  await prisma.taskRunFeishuRelay.upsert({ where: { taskRunId: run.id },
    create: { taskRunId: run.id, bindingId: binding.id }, update: {} });
  const changed = await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-reply-topic:${binding.id}`})) AS locked`;
    if (!lock.locked) return false;
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true, task: { select: { name: true } } } });
    const cursor = await tx.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: run.id } });
    if (cursor.bindingId !== binding.id) throw new Error(`Reply target changed for ${run.id}; reconcile the original card`);
    const replyOwner = await conversationReplyOwner(tx, run, binding.id);
    if (replyOwner?.superseded) {
      await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id }, data: { lastStatus: 'superseded', ...(replyOwner.messageId ? { messageId: replyOwner.messageId } : {}) } });
      return false;
    }
    const newest = await tx.taskRunFeishuRelay.findFirstOrThrow({ where: { bindingId: binding.id },
      orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }] });
    const older = newest.taskRunId !== run.id;
    const sharedCard = !replyOwner && cursor.messageId && await tx.taskRunFeishuRelay.findFirst({ where: { bindingId: binding.id, taskRunId: { not: run.id }, messageId: cursor.messageId }, select: { taskRunId: true } });
    // Older runs may finalize their own card, but must never overwrite a shared legacy card.
    if (older && !replyOwner && (!cursor.messageId || sharedCard)) {
      await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id }, data: { lastStatus: 'superseded' } });
      return false;
    }
    const continuing = await conversationHandoffPending(tx, run);
    const displayStatus = continuing ? 'continuing' : run.status;
    const latest = await tx.taskRunEvent.findFirst({ where: { taskRunId: run.id }, orderBy: { sequence: 'desc' } });
    const sequence = latest?.sequence || 0;
    const requests = await tx.taskRunInteractionRequest.findMany({ where: { taskRunId: run.id, status: 'pending' } });
    const expiredSinceDelivery = requests.some((request) => request.expiresAt && request.expiresAt <= new Date() && request.expiresAt > cursor.updatedAt);
    const execution = await tx.taskGraphExecution.findFirst({ where: { childTask: { liveRooms: { some: { id: binding.liveRoomId } } } },
      select: { id: true, nodeId: true, childTaskId: true, repository: true, worktreePath: true, worktreeBranch: true, node: { select: { runId: true } } } });
    const sizeChanged = run.participants.some(participant => {
      const sample = readSessionSize(participant.controlMetadata, { participantId: participant.id,
        startedAt: run.startedAt?.getTime() || participant.startedAt?.getTime() || Date.now() });
      return sample && sample.observedAt > cursor.updatedAt.getTime();
    });
    if (!forceRefresh && !sharedCard && !sizeChanged && cursor.deliveredSequence === sequence && (cursor.lastStatus === displayStatus || older && cursor.lastStatus === 'superseded') && !expiredSinceDelivery) {
      if (older && cursor.lastStatus !== 'superseded' && !['running', 'pending', 'waiting_for_input'].includes(run.status)) {
        await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id }, data: { lastStatus: 'superseded' } });
      }
      return false;
    }
    const output = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: 'stdout_chunk' }, orderBy: { sequence: 'desc' }, take: 1000 });
    const history = await tx.taskRunEvent.findMany({ where: { taskRunId: run.id, eventType: { notIn: ['stdout_chunk', 'stderr_chunk', 'summary'] } }, orderBy: { sequence: 'desc' }, take: 100 });
    output.reverse();
    const conversation = execution && await tx.taskGraphEvent.findFirst({ where: {
      runId: execution.node.runId, nodeId: execution.nodeId, kind: 'conversation_followup_bound',
      AND: [{ payload: { path: ['taskRunId'], equals: run.id } }, { payload: { path: ['executionId'], equals: execution.id } }],
    }, select: { id: true } });
    const card = buildRunReplyCard({ ...run, ...(execution ? { graphWorkspace: { repository: execution.repository, executionId: execution.id, branch: execution.worktreeBranch, path: execution.worktreePath } } : {}),
      ...(conversation ? { replyKind: 'conversation' } : {}) }, history.reverse(), requests, output);
    if (continuing) {
      card.header.title.content = card.header.title.content.replace('执行完成', '正在继续');
      card.header.template = 'blue';
    }
    card.header.title.content = `${run.task.name} · ${card.header.title.content}`;
    const messageId = await deliverProgressCard({ bindingId: binding.id, runId: execution?.node.runId,
      childTaskId: execution?.childTaskId || undefined, chatId: binding.chatId, rootMessageId, card,
      taskRunId: run.id, replyIdentity: replyOwner?.identity, messageId: replyOwner?.messageId || (sharedCard ? null : cursor.messageId), firstRun: cursor });
    if (!messageId) throw new Error('Reply card send returned no message id');
    await tx.taskRunFeishuRelay.update({ where: { taskRunId: run.id },
      data: { messageId, deliveredSequence: sequence, lastStatus: older && !['running', 'pending', 'waiting_for_input'].includes(run.status) ? 'superseded' : displayStatus } });
    return true;
  }, { timeout: 25_000 });
  if (!['running', 'pending', 'waiting_for_input'].includes(run.status)) {
    try {
      const final = run.participants.map(participant => participant.summary || participant.error || '').filter(Boolean).join('\n\n') || run.summary || '';
      await deliverRunReplyImages(run.id, final, binding);
    } catch (error) {
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      const job = await prisma.taskGraphExecution.findUnique({ where: { childTaskId: run.taskId } });
      if (job) {
        const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } });
        await queueGraphNotification(node.runId, `reply-image-failed:${run.id}`, { kind: 'child_progress', childTaskId: run.taskId,
          eventKey: `reply-image-failed:${run.id}`, text: `文字答复已保留，图片未确认送达。${detail}。平台应核对发送回执后处理，不能直接重发。` });
      }
      console.error('[TaskGraphReplies] image delivery failed; text retained', { taskRunId: run.id, error: detail });
    }
  }
  return changed;
}

export async function relayTaskGraphReplies() {
  const runs = await prisma.taskRun.findMany({ where: { AND: [{ OR: [
    { task: { taskGraphExecutions: { some: {} } } }, { taskId: { startsWith: 'task-graph-' } },
  ] }],
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
