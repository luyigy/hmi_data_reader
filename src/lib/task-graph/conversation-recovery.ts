import { graphRecoveryKind, isRecord, type RecoveryKind } from './implementation-result';
import { prisma } from '../prisma';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';

export class GraphRecoveryTargetAmbiguous extends Error {
  constructor(public readonly runId: string, public readonly choices: string[]) { super(`请说明要继续哪个任务：${choices.join('、')}。回复任务代号即可。`); Object.setPrototypeOf(this, new.target.prototype); }
}

/** Persist the user's explicit request; the coordinator alone resumes the recorded phase. */
export async function requestGraphConversationRecovery(args: { roomId: string; chatId: string; openId: string; messageId: string; text?: string; nodeKey?: string }) {
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoomId: args.roomId, chatId: args.chatId }, include: { liveRoom: true } });
  if (!binding || (!isFeishuAdmin(args.openId) && !(binding.chatType === 'group' && await isFeishuGroupAdmin(args.chatId, args.openId)))) {
    throw new Error('只有任务会话的管理员可继续任务');
  }
  if (!binding.liveRoom.sourceTaskId || binding.liveRoom.status !== 'active') throw new Error('任务话题未绑定或已归档');
  const sourceTaskId = binding.liveRoom.sourceTaskId;
  let execution = await prisma.taskGraphExecution.findFirst({ where: { childTaskId: sourceTaskId }, include: { node: { include: { executions: true } } } });
  if (!execution) {
    const run = await prisma.taskGraphRun.findFirst({ where: { parentTaskId: sourceTaskId }, orderBy: { version: 'desc' }, include: { nodes: { include: { executions: true } } } });
    if (!run) throw new Error('当前话题没有可恢复的任务路线');
    const mentioned = run.nodes.filter(node => new RegExp(`(^|[^A-Za-z0-9_-])${node.key}([^A-Za-z0-9_-]|$)`, 'i').test(args.text || ''));
    const paused = run.nodes.filter(node => node.status === 'attention');
    const candidates = args.nodeKey ? run.nodes.filter(node => node.key === args.nodeKey) : mentioned.length ? mentioned : paused.length ? paused : run.nodes.filter(node => ['ready', 'claimed', 'verifying'].includes(node.status));
    if (candidates.length > 1) throw new GraphRecoveryTargetAmbiguous(run.id, candidates.map(node => node.key));
    if (!candidates.length) throw new Error('当前没有可定位的暂停任务，请指定 Slice 代号。');
    execution = await prisma.taskGraphExecution.findFirst({ where: { nodeId: candidates[0].id }, include: { node: { include: { executions: true } } } });
  }
  if (!execution || args.nodeKey && execution.node.key !== args.nodeKey) throw new Error('恢复目标不属于当前任务');
  const key = `conversation:review-recovery:${args.messageId}`;
  const existing = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: execution.node.runId, idempotencyKey: key } } });
  if (existing) return existing;
  const running = ['claimed', 'ready', 'verifying'].includes(execution.node.status);
  const complete = ['passed', 'delivered_unverified'].includes(execution.node.status);
  const recoveryKind = await graphRecoveryKind(execution.nodeId);
  if (!running && !complete && (execution.node.status !== 'attention' ||
      (recoveryKind === 'verification' && execution.node.executions.some(job => job.status !== 'integrated')))) {
    throw new Error('实施或集成仍未完成，不能跳过；平台将保留原任务处理。');
  }
  return prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: execution.node.runId, idempotencyKey: key } }, create: {
    runId: execution.node.runId, nodeId: execution.nodeId, idempotencyKey: key,
    kind: running ? 'conversation_review_already_running' : complete ? 'conversation_review_already_complete' : 'conversation_review_recovery_requested', payload: { actorId: args.openId, childTaskId: execution.childTaskId, messageId: args.messageId, requestRoomId: args.roomId, requestText: args.text || '', recoveryKind, blockedPhase: recoveryKind === 'implementation' ? 'implementation' : 'acceptance', nodeStatus: execution.node.status },
  }, update: {} });
}

/** Return work to the coordinator's existing in-flight set; never run inside the Feishu callback. */
export async function startConversationRecoveries(recover: (runId: string, nodeKey: string, recoveryKind: RecoveryKind, requestId: string) => Promise<unknown>) {
  const requests = await prisma.taskGraphEvent.findMany({ where: { kind: 'conversation_review_recovery_requested', run: { status: { not: 'paused' } }, node: { status: 'attention' } },
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
    await prisma.taskGraphEvent.createMany({ data: requests.filter(other => other.nodeId === node.id && other.id !== request.id).map(other => ({
      runId: other.runId, nodeId: node.id, idempotencyKey: `conversation:review-recovery:${other.id}:started`,
      kind: 'conversation_review_recovery_superseded', payload: { supersededBy: request.id },
    })), skipDuplicates: true });
    scheduled.add(node.id);
    const recoveryKind = isRecord(request.payload) && request.payload.recoveryKind === 'implementation' ? 'implementation' : 'verification';
    const promise = recover(request.runId, node.key, recoveryKind, request.id).then(async () => {
      await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':finished', kind: 'conversation_review_recovery_finished', payload: {} } });
    }).catch(async (error: unknown) => {
      await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':failed', kind: 'conversation_review_recovery_failed',
        payload: { detail: error instanceof Error ? error.message : String(error) } } });
    });
    work.push({ nodeId: node.id, promise });
  }
  return work;
}
