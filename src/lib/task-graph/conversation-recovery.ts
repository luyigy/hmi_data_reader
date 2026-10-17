import { prisma } from '../prisma';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';

/** Persist the user's explicit request; the coordinator alone runs the review. */
export async function requestGraphConversationRecovery(args: { roomId: string; chatId: string; openId: string; messageId: string }) {
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoomId: args.roomId, chatId: args.chatId }, include: { liveRoom: true } });
  if (!binding || (!isFeishuAdmin(args.openId) && !(binding.chatType === 'group' && await isFeishuGroupAdmin(args.chatId, args.openId)))) {
    throw new Error('只有任务会话的管理员可恢复验收');
  }
  if (!binding.liveRoom.sourceTaskId || binding.liveRoom.status !== 'active') throw new Error('任务话题未绑定或已归档');
  const execution = await prisma.taskGraphExecution.findFirst({ where: { childTaskId: binding.liveRoom.sourceTaskId }, include: { node: { include: { executions: true } } } });
  if (!execution) throw new Error('请在对应 Slice 子话题中恢复验收');
  const key = `conversation:review-recovery:${args.messageId}`;
  const existing = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: execution.node.runId, idempotencyKey: key } } });
  if (existing) return existing;
  if (execution.node.status !== 'attention' || execution.node.executions.some((job) => job.status !== 'integrated')) {
    throw new Error('当前不是可恢复的验收暂停；实施或集成仍未完成时不能跳过');
  }
  return prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: execution.node.runId, idempotencyKey: key } }, create: {
    runId: execution.node.runId, nodeId: execution.nodeId, idempotencyKey: key,
    kind: 'conversation_review_recovery_requested', payload: { actorId: args.openId, childTaskId: execution.childTaskId, messageId: args.messageId },
  }, update: {} });
}

/** Return work to the coordinator's existing in-flight set; never run inside the Feishu callback. */
export async function startConversationRecoveries(recover: (runId: string, nodeKey: string) => Promise<unknown>) {
  const requests = await prisma.taskGraphEvent.findMany({ where: { kind: 'conversation_review_recovery_requested', node: { status: 'attention' } },
    include: { node: true }, orderBy: { createdAt: 'desc' }, take: 20 });
  const work: { nodeId: string; promise: Promise<void> }[] = [];
  const scheduled = new Set<string>();
  for (const request of requests) {
    const node = request.node;
    if (!node || scheduled.has(node.id)) continue;
    const key = `conversation:review-recovery:${request.id}:started`;
    try { await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key, kind: 'conversation_review_recovery_started', payload: {} } }); }
    catch (error) {
      if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: request.runId, idempotencyKey: key } } })) continue;
      throw error;
    }
    scheduled.add(node.id);
    const promise = recover(request.runId, node.key).then(async () => {
      await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':finished', kind: 'conversation_review_recovery_finished', payload: {} } });
    }).catch(async (error: unknown) => {
      await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':failed', kind: 'conversation_review_recovery_failed',
        payload: { detail: error instanceof Error ? error.message : String(error) } } });
    });
    work.push({ nodeId: node.id, promise });
  }
  return work;
}
