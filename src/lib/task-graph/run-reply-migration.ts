import { prisma } from '../prisma';

/** Explicitly relocate an existing DM receipt; never silently retarget its card. */
export async function moveGraphReplyToChildTopic(taskRunId: string, bindingId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`graph-reply:${taskRunId}`}))`;
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
    const execution = await tx.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId: run.taskId },
      include: { node: { include: { run: true } } } });
    const destination = await tx.feishuConversationBinding.findUniqueOrThrow({ where: { id: bindingId }, include: { liveRoom: true } });
    if (destination.chatType !== 'group' || !destination.rootMessageId || !destination.threadId
      || destination.liveRoom.sourceTaskId !== run.taskId) throw new Error('进度目标不是本任务的已绑定群子话题');
    const previous = await tx.taskRunFeishuRelay.findUnique({ where: { taskRunId } });
    if (!previous || previous.bindingId === destination.id) return previous;
    const source = await tx.feishuConversationBinding.findUniqueOrThrow({ where: { id: previous.bindingId }, include: { liveRoom: true } });
    if (source.chatType !== 'p2p' || source.liveRoom.sourceTaskId !== execution.node.run.parentTaskId) {
      throw new Error('只允许将原父任务私聊进度显式迁到本任务子话题');
    }
    await tx.taskGraphEvent.create({ data: { runId: execution.node.runId, nodeId: execution.nodeId,
      kind: 'reply_target_migrated', idempotencyKey: `reply-target:${taskRunId}:${destination.id}`,
      payload: { taskRunId, destinationBindingId: destination.id, destinationChatId: destination.chatId,
        destinationRootMessageId: destination.rootMessageId,
        previous: { bindingId: previous.bindingId, messageId: previous.messageId, deliveredSequence: previous.deliveredSequence,
          lastStatus: previous.lastStatus, createdAt: previous.createdAt.toISOString(), updatedAt: previous.updatedAt.toISOString() } } } });
    return tx.taskRunFeishuRelay.update({ where: { taskRunId }, data: {
      bindingId: destination.id, messageId: null, deliveredSequence: -1, lastStatus: '', createdAt: new Date(),
    } });
  });
}
