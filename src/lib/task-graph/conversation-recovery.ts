import { randomUUID } from 'node:crypto';
import { graphRecoveryKind, type RecoveryKind } from './implementation-result';
import { prisma } from '../prisma';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { observeExecutionWriter } from './phase-worker';

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
  const pending = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "TaskGraphEvent" r
    JOIN "TaskGraphRun" g ON g.id = r."runId"
    JOIN "TaskGraphNode" n ON n.id = r."nodeId"
    WHERE r.kind = 'conversation_review_recovery_requested' AND g.status <> 'paused' AND n.status = 'attention'
      AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" done WHERE done."runId" = r."runId" AND (
        done."idempotencyKey" = 'conversation:review-recovery:' || r.id || ':started:finished'
        OR done."idempotencyKey" = 'conversation:review-recovery:' || r.id || ':started' AND done.kind = 'conversation_review_recovery_superseded'))
    ORDER BY r."createdAt" DESC, r.id DESC LIMIT 20`;
  const requests = await prisma.taskGraphEvent.findMany({ where: { id: { in: pending.map(request => request.id) } },
    include: { node: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const work: { nodeId: string; promise: Promise<void> }[] = [];
  const scheduled = new Set<string>();
  for (const request of requests) {
    const node = request.node;
    if (!node || scheduled.has(node.id)) continue;
    const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
    if (!(await Promise.all(jobs.map(observeExecutionWriter))).every(proof => proof.kind === 'exited')) continue;
    const key = `conversation:review-recovery:${request.id}:started`;
    const completed = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: request.runId, idempotencyKey: key + ':finished' } } });
    if (completed) continue;
    scheduled.add(node.id);
    const recoveryKind = await graphRecoveryKind(node.id);
    const promise = (async () => {
      try { await recover(request.runId, node.key, recoveryKind, request.id); }
      catch (error) {
        // A failed attempt is evidence, not consumption of the durable request.
        await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id,
          idempotencyKey: key + ':failed:' + randomUUID(), kind: 'conversation_review_recovery_failed',
          payload: { detail: error instanceof Error ? error.message : String(error) } } });
      }
      // Scheduling owns the node lock and request idempotency key. It may have committed
      // even if its caller lost the response or the subsequently launched review failed.
      const receipt = await prisma.taskGraphEvent.findFirst({ where: { runId: request.runId, nodeId: node.id,
        idempotencyKey: { in: [`node:${node.key}:implementation-recovery:${request.id}`, `node:${node.key}:verification-recovery:${request.id}`] } } });
      if (!receipt) return;
      await prisma.taskGraphEvent.createMany({ data: [
        { runId: request.runId, nodeId: node.id, idempotencyKey: key, kind: 'conversation_review_recovery_started', payload: { receiptId: receipt.id } },
        { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':finished', kind: 'conversation_review_recovery_finished', payload: { receiptId: receipt.id } },
        ...requests.filter(other => other.nodeId === node.id && other.id !== request.id).map(other => ({
          runId: other.runId, nodeId: node.id, idempotencyKey: `conversation:review-recovery:${other.id}:started:finished`,
          kind: 'conversation_review_recovery_superseded', payload: { supersededBy: request.id, receiptId: receipt.id },
        })),
      ], skipDuplicates: true });
    })();
    work.push({ nodeId: node.id, promise });
  }
  return work;
}
