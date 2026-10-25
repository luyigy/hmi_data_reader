import { prisma } from '../prisma';
import { buildRunReplyCard } from './run-reply-card';
import { conversationReplyIdentity } from './conversation-reply-identity';
import { runBinding } from './run-reply-relay';
import { deliverProgressCard } from './progress-card-delivery';

/** Pre-TaskRun failures use the same durable source identity as the eventual native turn. */
export async function deliverConversationDeferredCard(args: {
  taskId: string; executionId: string; runId: string; rootInputId: string; reason: string;
}) {
  const binding = await runBinding(args.taskId);
  if (!binding) return;
  const identity = conversationReplyIdentity(args.executionId, args.rootInputId);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`graph-reply-topic:${binding.id}`}))`;
    // A late preparation failure must never replace an already bound native answer.
    if (await tx.taskRun.count({ where: { controlMetadata: { contains: JSON.stringify({ graphReplyIdentity: identity }).slice(1, -1) } } })) return;
    const card = buildRunReplyCard({ id: args.rootInputId, status: 'failed', participants: [], error: null,
      summary: `本轮会话尚未启动：${args.reason.slice(0, 1000)}。原消息和业务进度保留；同一输入最多尝试四次，后续答复更新本卡。` }, []);
    card.header.title.content = '启动前失败';
    const messageId = await deliverProgressCard({ bindingId: binding.id, runId: args.runId, childTaskId: args.taskId,
      chatId: binding.chatId, rootMessageId: binding.rootMessageId, replyIdentity: identity, card });
    const input = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: args.rootInputId } });
    const source = input.payload;
    const target = source && typeof source === 'object' && !Array.isArray(source) ? source.target : null;
    if (messageId && target && typeof target === 'object' && !Array.isArray(target) && typeof target.taskRunId === 'string') {
      const key = { runId: args.runId, idempotencyKey: `conversation-reply-card:${identity}` };
      await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: key }, update: {},
        create: { ...key, nodeId: input.nodeId, kind: 'conversation_reply_card', payload: {
          bindingId: binding.id, messageId, taskRunId: target.taskRunId, inputId: input.id } } });
    }
  }, { timeout: 25_000 });
}
