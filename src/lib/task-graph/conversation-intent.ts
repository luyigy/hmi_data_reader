import { isRecord } from './implementation-result';
import { prisma } from '../prisma';
import { replyFeishuMessage } from '../feishu-api';
import { requestGraphConversationRecovery, GraphRecoveryTargetAmbiguous } from './conversation-recovery';

function continuationAction(text: string) {
  const clauses = text.replace(/@_user_\d+|\$[A-Za-z0-9_-]+/g, '').split(/[，,。！!；;\n]/).map(part => part.trim()).filter(Boolean);
  const executionCommand = /^(?:[A-Za-z][A-Za-z0-9_-]{0,31}\s+)?(?:(?:你们?|请|麻烦|现在|直接|马上|开始|先|帮我)\s*)*(?:执行|实施)(?=$|[\s啊吧呀]|这个|本任务|原任务)/;
  return clauses.filter(part => /继续|恢复|接着|往下走|重跑|重新(?:跑|执行|实施|验收)|用[\s\S]{0,70}(?:验收|测试|复测|复核|测一下|做验证)/.test(part) || executionCommand.test(part)).at(-1);
}

export function hasContinuationAuthorization(text: string) {
  if (/[?？]|咋回事|怎么回事|为什么|为何|怎么|如何|吗|没有|没|并未|说是|好像|以为/.test(text)) return false;
  const action = continuationAction(text);
  if (!action || /[?？]|(?:吗|么)[呀啊呢吧\s]*$|能不能|可不可以|是否|好不好|行不行|为什么|为何|怎么|如何|还缺/.test(action)) return false;
  if (/(?:以后|下次|明天|稍后|等[\s\S]+(?:后|再)|如果)[\s\S]*(?:继续|恢复|接着|执行|实施|重跑|重新跑)/.test(action)) return false;
  return !/(?:不要|不需要|不用|不必|不想|先别|暂不|别)[\s\S]{0,10}(?:继续|恢复|启动|执行|实施|重跑|验收|测试|复核|跑)|不(?:再|去|马上|现在|想)?\s*(?:继续|恢复|启动|执行|实施|重跑|验收|测试|复核|跑)/.test(action);
}
export function resumeIntent(text: string) {
  return hasContinuationAuthorization(text) && !/(?:继续|恢复|接着|重跑|执行|实施)[\s\S]{0,8}(?:讨论|聊天|设计|规划|写方案)/.test(continuationAction(text) || '');
}
export type GraphContinuationInput = { roomId: string; chatId: string; openId: string; messageId: string; text: string; nodeKey?: string; chatType?: string; threadId?: string };

/** Only inbound human messages reach this entry. The coordinator consumes the durable request. */
export async function handleGraphConversationIntent(args: GraphContinuationInput, fromControl = false) {
  let selectedPendingId: string | undefined;
  if (!(fromControl ? hasContinuationAuthorization(args.text) : resumeIntent(args.text))) {
    const key = args.text.replace(/@_user_\d+|\$[A-Za-z0-9_-]+/g, '').trim().replace(/[。！!]+$/, '');
    const cancellation = /不用了|取消恢复|暂停验收|停止验收|不要继续|先别继续/.test(args.text);
    if (!cancellation && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) return false;
    const pending = await prisma.taskGraphEvent.findFirst({ where: { kind: 'conversation_recovery_target_requested', createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
      AND: [{ payload: { path: ['roomId'], equals: args.roomId } }, { payload: { path: ['actorId'], equals: args.openId } }] }, orderBy: { createdAt: 'desc' } });
    if (pending && cancellation) {
      await prisma.taskGraphEvent.createMany({ data: [{ runId: pending.runId, idempotencyKey: `${pending.id}:resolved`, kind: 'conversation_recovery_target_cancelled', payload: { messageId: args.messageId } }], skipDuplicates: true });
      return false;
    }
    const selection = pending?.payload as { choices?: string[]; text?: string } | undefined;
    if (!pending || !selection?.choices?.includes(key) || await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: pending.runId, idempotencyKey: `${pending.id}:resolved` } } })) return false;
    selectedPendingId = pending.id;
    args = { ...args, text: selection.text || '继续验收', nodeKey: key };
  }
  const room = await prisma.liveRoom.findUnique({ where: { id: args.roomId }, select: { sourceTaskId: true } });
  if (!room?.sourceTaskId) return false;
  if (!await prisma.taskGraphRun.count({ where: { OR: [{ parentTaskId: room.sourceTaskId }, { nodes: { some: { executions: { some: { childTaskId: room.sourceTaskId } } } } }] } })) return false;
  let text: string;
  let uuid: string;
  try {
    const event = await requestGraphConversationRecovery(args);
    const payload = isRecord(event.payload) ? event.payload : {};
    text = event.kind === 'conversation_review_already_running' ? '这个任务正在执行，无需重复启动。'
      : event.kind === 'conversation_review_already_complete' ? payload.nodeStatus === 'delivered_unverified' ? '这个任务已按仅实施模式交付，尚未独立验收。若要独立验收，需明确调整批准的模式；本次不会重复实施。' : '这个任务已完成验收，无需重复启动。'
      : payload.recoveryKind === 'implementation' ? '已登记接续原任务实施，平台会从已保存进度读取父子话题新材料；输入或现场存在问题时会明确暂停，不会误作已交付。' : '已接续原任务验收。平台会读取父子话题中的材料，结果回到原话题。';
    uuid = `graph-continue-${event.id}`;
    if (selectedPendingId) await prisma.taskGraphEvent.createMany({ data: [{ runId: event.runId, nodeId: event.nodeId, idempotencyKey: `${selectedPendingId}:resolved`, kind: 'conversation_recovery_target_resolved', payload: { messageId: args.messageId } }], skipDuplicates: true });
  } catch (error) {
    if (error instanceof GraphRecoveryTargetAmbiguous) await prisma.taskGraphEvent.createMany({ data: [{ runId: error.runId, idempotencyKey: `conversation:target:${args.messageId}`, kind: 'conversation_recovery_target_requested', payload: { roomId: args.roomId, actorId: args.openId, choices: error.choices, text: args.text, messageId: args.messageId } }], skipDuplicates: true });
    text = error instanceof Error ? error.message : String(error);
    uuid = `graph-continue-error-${args.messageId}`;
  }
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoomId: args.roomId, chatId: args.chatId }, select: { chatType: true, threadId: true } });
  const replyInThread = (args.chatType || binding?.chatType) !== 'p2p' || !!(args.threadId || binding?.threadId);
  await replyFeishuMessage({ messageId: args.messageId, msgType: 'text', content: { text }, replyInThread, uuid });
  return true;
}

export async function applyGraphControlOutput(args: { output: string; roomId: string; sourceContent: string; sourceMetadata: string | null }) {
  const pattern = /<graph-control>([\s\S]*?)<\/graph-control>/g;
  const blocks = Array.from(args.output.matchAll(pattern));
  if (!blocks.length) return args.output;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(args.sourceMetadata || '{}'); } catch { /* No authenticated inbound origin. */ }
  let message = '未恢复任务：控制块缺少有效的人类授权来源。';
  if (blocks.length === 1 && metadata.source === 'feishu' && typeof metadata.feishuSenderOpenId === 'string' && typeof metadata.feishuChatId === 'string' && typeof metadata.feishuMessageId === 'string') {
    try {
      const command = JSON.parse(blocks[0][1]);
      if (!['resume_task', 'resume_acceptance'].includes(command.action) || typeof command.nodeKey !== 'string') throw new Error('无效的任务恢复指令');
      const handled = await handleGraphConversationIntent({ roomId: args.roomId, chatId: metadata.feishuChatId, openId: metadata.feishuSenderOpenId,
        messageId: metadata.feishuMessageId, text: args.sourceContent, nodeKey: command.nodeKey }, true);
      message = handled ? '平台已回复本次继续请求，请以平台状态回报为准。' : '本条消息没有明确要求继续执行，任务状态保持。';
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
  }
  return [args.output.replace(pattern, '').trim(), message].filter(Boolean).join('\n\n');
}
