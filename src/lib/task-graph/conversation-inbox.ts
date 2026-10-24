import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { executionProgress, metadataWithProgress } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import type { HarnessSteer } from '../acpx/types';
import { observeTaskRunWriter } from './writer-ownership';
import { syncGraphConversationMaterials } from './conversation-materials';

export type ConversationInput = { id: string; executionId: string; sourceId: string; actorId: string; content: string;
  rootInputId: string; actorOrigin: 'feishu' | 'platform' | 'room'; sourceMetadata: string | null; roomMessageId?: string; receivedPhase: string; receivedState: string };
function parseInput(id: string, raw: Prisma.JsonValue): ConversationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.executionId !== 'string' || typeof raw.sourceId !== 'string' ||
    typeof raw.actorId !== 'string' || typeof raw.content !== 'string' || typeof raw.receivedPhase !== 'string' || typeof raw.receivedState !== 'string') throw new Error('Invalid conversation input');
  return { id, rootInputId: typeof raw.rootInputId === 'string' ? raw.rootInputId : id, executionId: raw.executionId, sourceId: raw.sourceId, actorId: raw.actorId, content: raw.content,
    actorOrigin: raw.actorOrigin === 'feishu' || raw.actorOrigin === 'platform' ? raw.actorOrigin : 'room',
    sourceMetadata: typeof raw.sourceMetadata === 'string' ? raw.sourceMetadata : null,
    ...(typeof raw.roomMessageId === 'string' ? { roomMessageId: raw.roomMessageId } : {}), receivedPhase: raw.receivedPhase, receivedState: raw.receivedState };
}
export const conversationReceiptKey = (id: string) => `conversation-input:${id}:delivery`;
const unassignedInput = Prisma.sql`i.kind = 'conversation_input'
  AND EXISTS (SELECT 1 FROM "TaskGraphRun" g WHERE g.id = i."runId" AND g.status <> 'paused')
  AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" r WHERE r."runId" = i."runId" AND r."idempotencyKey" = 'conversation-input:' || i.id || ':delivery')
  AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" s WHERE s."runId" = i."runId" AND s."idempotencyKey" = 'conversation-input:' || i.id || ':delivery:steering'
    AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" r WHERE r."runId" = s."runId" AND r."idempotencyKey" = s."idempotencyKey" || ':result' AND r.payload->>'result' = 'rejected'))`;

export async function pendingConversationNodes() {
  return prisma.$queryRaw<{ nodeId: string }[]>(Prisma.sql`SELECT i."nodeId" FROM "TaskGraphEvent" i
    WHERE ${unassignedInput} AND i."nodeId" IS NOT NULL GROUP BY i."nodeId" ORDER BY min(i."createdAt") LIMIT 50`);
}

export async function conversationInputsByIds(tx: Prisma.TransactionClient, runId: string, executionId: string, ids: string[]) {
  const inputs = await tx.taskGraphEvent.findMany({ where: { id: { in: ids }, runId, kind: 'conversation_input',
    payload: { path: ['executionId'], equals: executionId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return inputs.map(input => parseInput(input.id, input.payload));
}

export async function pendingConversationInputs(tx: Prisma.TransactionClient, runId: string, executionId: string): Promise<ConversationInput[]> {
  const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT i.id FROM "TaskGraphEvent" i
    WHERE i."runId" = ${runId} AND ${unassignedInput} AND i.payload->>'executionId' = ${executionId}
    ORDER BY i."createdAt", i.id LIMIT 50`);
  const inputs = await tx.taskGraphEvent.findMany({ where: { id: { in: ids.map(item => item.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return inputs.map(input => parseInput(input.id, input.payload));
}

/** Messages target an execution, never whichever TaskRun happens to be newest. */
export type GraphTaskMessageInput = { taskId: string; sourceId: string; actorId: string; actorOrigin?: ConversationInput['actorOrigin']; content: string; roomMessageId?: string; sourceMetadata?: string | null };

export async function receiveGraphTaskMessageTx(tx: Prisma.TransactionClient, args: GraphTaskMessageInput) {
  const original = await tx.taskGraphExecution.findUnique({ where: { childTaskId: args.taskId }, include: { node: true } });
  if (!original) return false;
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: original.id }, include: { node: { include: { run: true } } } });
  const progress = executionProgress(job.dispatchMetadata);
  await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: job.node.runId,
    idempotencyKey: `conversation-input:${job.id}:${args.sourceId}` } }, update: {}, create: {
    runId: job.node.runId, nodeId: job.nodeId, kind: 'conversation_input', idempotencyKey: `conversation-input:${job.id}:${args.sourceId}`,
    payload: { executionId: job.id, sourceId: args.sourceId, actorId: args.actorId, actorOrigin: args.actorOrigin || 'room', content: args.content, sourceMetadata: args.sourceMetadata || null,
      ...(args.roomMessageId ? { roomMessageId: args.roomMessageId } : {}), receivedPhase: progress?.phase || 'prepare', receivedState: progress?.state || job.status },
  } });
  return true;
}

export async function receiveGraphTaskMessage(args: GraphTaskMessageInput) {
  return prisma.$transaction(tx => receiveGraphTaskMessageTx(tx, args));
}

/** A persisted room message can be retried after enqueue failed or the webhook disconnected. */
export async function receiveGraphRoomMessage(roomId: string, roomMessageId: string) {
  const room = await prisma.liveRoom.findUnique({ where: { id: roomId }, select: { sourceTaskId: true } });
  if (!room?.sourceTaskId) return false;
  const message = await prisma.liveRoomMessage.findFirst({ where: { id: roomMessageId, roomId, messageType: 'user' } });
  if (!message) return false;
  let actorId = message.senderMemberId || 'room-user';
  let actorOrigin: ConversationInput['actorOrigin'] = 'room';
  let sourceId = `room:${message.id}`;
  try { const metadata: unknown = JSON.parse(message.metadata || '{}');
    if (metadata && typeof metadata === 'object' && 'source' in metadata && metadata.source === 'feishu' && 'feishuSenderOpenId' in metadata && typeof metadata.feishuSenderOpenId === 'string') { actorId = metadata.feishuSenderOpenId; actorOrigin = 'feishu'; }
    if (metadata && typeof metadata === 'object' && 'source' in metadata && metadata.source === 'feishu' && 'feishuMessageId' in metadata && typeof metadata.feishuMessageId === 'string') sourceId = `feishu:${metadata.feishuMessageId}`;
  } catch { /* Non-Feishu room messages use their persisted room member identity. */ }
  return receiveGraphTaskMessage({ taskId: room.sourceTaskId, sourceId, actorId, actorOrigin, content: message.content, roomMessageId: message.id, sourceMetadata: message.metadata });
}

/** Input assignment and TaskRun creation commit together; processing is acknowledged separately. */
export async function bindConversationInputs(tx: Prisma.TransactionClient, executionId: string, inputIds: string[], taskRunId: string) {
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
  const pending = await pendingConversationInputs(tx, job.node.runId, job.id);
  for (const id of inputIds) {
    if (!pending.some(input => input.id === id)) throw new Error('Conversation input already claimed or belongs to another task');
    await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'conversation_input_bound',
      idempotencyKey: conversationReceiptKey(id), payload: { executionId, inputId: id, taskRunId, delivery: 'turn' } } });
  }
}

export async function completeConversationTurn(executionId: string, taskRunId: string) {
  await prisma.$transaction(async tx => {
    const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
    if (run.taskId !== job.childTaskId || !['completed', 'failed', 'stopped', 'interrupted'].includes(run.status)) throw new Error('Conversation run has no terminal result');
    await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: `conversation-turn:${taskRunId}:result` } }, update: {}, create: {
      runId: job.node.runId, nodeId: job.nodeId, idempotencyKey: `conversation-turn:${taskRunId}:result`, kind: 'conversation_turn_result',
      payload: { executionId, taskRunId, status: run.status, summary: run.summary } } });
    const progress = executionProgress(job.dispatchMetadata);
    const currentOwner = progress?.conversation?.kind === 'running' ? progress.conversation.taskRunId === run.id : job.taskRunId === run.id && progress?.conversationOwnerRunId === run.id;
    if (progress && run.status === 'completed' && currentOwner) await tx.taskGraphExecution.update({ where: { id: job.id }, data: {
      dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { ...progress, conversationOwnerRunId: taskRunId }) } });
  });
}

/** An exited writer without a result retains its input as explicitly uncertain recovery context. */
export async function recoverConversationInputs(tx: Prisma.TransactionClient, executionId: string, taskRunId: string) {
  const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
  const bound = await tx.taskGraphEvent.findMany({ where: { runId: job.node.runId, kind: { in: ['conversation_input_bound', 'conversation_steering_started'] },
    payload: { path: ['taskRunId'], equals: taskRunId } } });
  for (const receipt of bound) {
    if (receipt.kind === 'conversation_steering_started') {
      const result = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: receipt.idempotencyKey + ':result' } } });
      if (result?.payload && typeof result.payload === 'object' && !Array.isArray(result.payload) && result.payload.result === 'rejected') continue;
    }
    const value = receipt.payload;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.inputId !== 'string') throw new Error('Invalid bound conversation input');
    const original = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: value.inputId } });
    const input = parseInput(original.id, original.payload);
    const key = `conversation-recovery:${original.id}:${taskRunId}`;
    await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } }, update: {}, create: {
      runId: job.node.runId, nodeId: job.nodeId, kind: 'conversation_input', idempotencyKey: key,
      payload: { ...input, sourceId: key, content: `上轮写入者已确认退出，但未保存处理结果，消息投递可能已经发生。先核对原会话和工作区已执行的操作，不要重复产生副作用。原消息：\n${input.content}`, receivedState: 'delivery_uncertain' } } });
  }
}

/** A binding is dispatch evidence, not proof that the original native turn processed the message. */
export async function reconcileConversationDeliveries() {
  const receipts = await prisma.$queryRaw<{ id: string }[]>`SELECT q.id FROM (
    SELECT r.id, r."createdAt", CASE WHEN t.status IN ('running', 'pending', 'waiting_for_input') THEN 1 ELSE 0 END AS active,
      row_number() OVER (PARTITION BY t.id ORDER BY r."createdAt", r.id) AS position
    FROM "TaskGraphEvent" r JOIN "TaskRun" t ON t.id = r.payload->>'taskRunId'
    WHERE r.kind IN ('conversation_input_bound', 'conversation_steering_started')
      AND NOT EXISTS (SELECT 1 FROM "TaskGraphEvent" s WHERE s."runId" = r."runId" AND s."idempotencyKey" = 'conversation-delivery:' || r.id || ':settled')
    ) q ORDER BY q.active, q.position, q."createdAt", q.id LIMIT 100`;
  for (const item of receipts) {
    const receipt = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: item.id } });
    const raw = receipt.payload;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.taskRunId !== 'string' ||
      typeof raw.executionId !== 'string' || typeof raw.inputId !== 'string') throw new Error('Invalid conversation dispatch receipt');
    const run = await prisma.taskRun.findUnique({ where: { id: raw.taskRunId } });
    if (!run || (await observeTaskRunWriter(run.id)).kind !== 'exited') continue;
    const executionId = raw.executionId, inputId = raw.inputId;
    if (['running', 'pending', 'waiting_for_input'].includes(run.status)) {
      const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
      if ((await observeExecutionWriter(job)).kind !== 'exited') continue;
    }
    await prisma.$transaction(async tx => {
      const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${run.id} FOR UPDATE`;
      const latestRun = await tx.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      const settled = `conversation-delivery:${receipt.id}:settled`;
      if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: settled } } })) return;
      const steeringResult = receipt.kind === 'conversation_steering_started' ? await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: receipt.idempotencyKey + ':result' } } }) : null;
      const rejected = steeringResult?.payload && typeof steeringResult.payload === 'object' && !Array.isArray(steeringResult.payload) && steeringResult.payload.result === 'rejected';
      const uncertain = !rejected && (latestRun.status !== 'completed' || receipt.kind === 'conversation_steering_started' && !steeringResult);
      if (uncertain) {
        const original = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: inputId } });
        const input = parseInput(original.id, original.payload);
        const key = `conversation-recovery:${original.id}:${run.id}`;
        await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: key } }, update: {}, create: {
          runId: receipt.runId, nodeId: receipt.nodeId, kind: 'conversation_input', idempotencyKey: key,
          payload: { ...input, sourceId: key, receivedState: 'delivery_uncertain',
            content: `上轮消息处理结果未知，原写入者已确认退出。此轮先在原生会话和工作区核对消息是否已执行，再处理尚未完成的部分；禁止机械重放副作用。原消息：\n${input.content}` } } });
      }
      if (receipt.kind === 'conversation_steering_started' && !steeringResult) await tx.taskGraphEvent.create({ data: {
        runId: receipt.runId, nodeId: receipt.nodeId, kind: 'conversation_steering_result', idempotencyKey: receipt.idempotencyKey + ':result',
        payload: { executionId: job.id, taskRunId: run.id, inputId: raw.inputId, result: 'unknown_preserved_for_reconciliation' } } });
      await tx.taskGraphEvent.create({ data: { runId: receipt.runId, nodeId: receipt.nodeId, kind: uncertain ? 'conversation_delivery_uncertain' : 'conversation_delivery_completed',
        idempotencyKey: settled, payload: { executionId: job.id, taskRunId: run.id, inputId: raw.inputId, result: rejected ? 'rejected' : uncertain ? 'uncertain' : 'completed_turn' } } });
    });
  }
}

export function conversationPrompt(inputs: ConversationInput[]) {
  return inputs.length ? '\n原任务话题的新消息，按顺序处理。\n' +
    inputs.map(input => JSON.stringify({ id: input.id, actor: input.actorId, content: input.content,
      receivedPhase: input.receivedPhase, receivedState: input.receivedState, sourceMetadata: input.sourceMetadata })).join('\n') : '';
}

export async function conversationInputs(executionId: string) {
  return prisma.$transaction(async tx => {
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
    return pendingConversationInputs(tx, job.node.runId, executionId);
  });
}

/** The node lock defines the cutoff: earlier input runs before integration; later input retains its received phase. */
export async function sealConversationTurn(executionId: string, claimToken: string, candidateCommit: string) {
  return prisma.$transaction(async tx => {
    const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
    const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
    const progress = executionProgress(job.dispatchMetadata);
    if (!progress || job.claimToken !== claimToken || job.status !== 'claimed') throw new Error('Conversation turn ownership changed');
    const pending = await pendingConversationInputs(tx, job.node.runId, job.id);
    const unknown = await tx.taskGraphEvent.findFirst({ where: { runId: job.node.runId, kind: 'conversation_steering_started',
      payload: { path: ['executionId'], equals: job.id }, NOT: { idempotencyKey: { in: (await tx.taskGraphEvent.findMany({
        where: { runId: job.node.runId, kind: 'conversation_steering_result' }, select: { idempotencyKey: true } })).map(event => event.idempotencyKey.replace(/:result$/, '')) } } } });
    if (unknown) throw new Error('Native steering delivery is unknown; preserve the current run and delivery evidence');
    await tx.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
      { ...progress, revision: progress.revision + 1, phase: pending.length ? 'implement' : 'integrate',
        state: pending.length ? 'waiting_for_user' : 'active', candidateCommit,
        ...(pending.length ? { lastFailure: undefined, waitingKind: 'question' as const, waitingMessage: '先处理原话题的新消息。' } : {}) }) ,
      ...(pending.length ? { status: 'attention', issueKind: null } : {}) } });
    if (pending.length) await tx.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'attention' } });
    return !pending.length;
  });
}

/** Direct platform input uses task ownership; room input must match its persisted authenticated source. */
export async function authorizedConversationInput(input: ConversationInput, taskId: string, ownerUserId: string | null, db: Prisma.TransactionClient = prisma) {
  if (input.rootInputId !== input.id) {
    const original = await db.taskGraphEvent.findFirst({ where: { id: input.rootInputId, kind: 'conversation_input', payload: { path: ['executionId'], equals: input.executionId } } });
    if (!original) return false;
    input = parseInput(original.id, original.payload);
    if (input.rootInputId !== input.id) return false;
  }
  if (input.actorOrigin === 'platform') return input.actorId === ownerUserId ||
    (await db.user.findUnique({ where: { id: input.actorId }, select: { role: true } }))?.role === 'admin';
  if (!input.roomMessageId) return false;
  const message = await db.liveRoomMessage.findFirst({ where: { id: input.roomMessageId, messageType: 'user', room: { sourceTaskId: taskId } } });
  if (!message || message.content !== input.content || message.metadata !== input.sourceMetadata) return false;
  if (input.actorOrigin === 'room') return message.senderMemberId === input.actorId && input.sourceId === `room:${message.id}`;
  let metadata: unknown;
  try { metadata = JSON.parse(message.metadata || 'null'); } catch { return false; }
  return !!metadata && typeof metadata === 'object' && 'source' in metadata && metadata.source === 'feishu' &&
    'feishuSenderOpenId' in metadata && metadata.feishuSenderOpenId === input.actorId &&
    'feishuMessageId' in metadata && input.sourceId === `feishu:${metadata.feishuMessageId}`;
}

/** Model handoff retains the owner/admin requirement; ordinary replies use their own input boundary. */
export async function authorizedMaterialHandoffInput(input: ConversationInput, taskId: string, ownerUserId: string | null, db: Prisma.TransactionClient = prisma) {
  if (!await authorizedConversationInput(input, taskId, ownerUserId, db)) return false;
  if (input.rootInputId !== input.id) {
    const original = await db.taskGraphEvent.findFirst({ where: { id: input.rootInputId, kind: 'conversation_input', payload: { path: ['executionId'], equals: input.executionId } } });
    if (!original) return false;
    input = parseInput(original.id, original.payload);
  }
  if (input.actorOrigin === 'platform') return true;
  if (input.actorOrigin !== 'feishu') return false;
  let metadata: unknown;
  try { metadata = JSON.parse(input.sourceMetadata || 'null'); } catch { return false; }
  const chat = metadata && typeof metadata === 'object' && 'feishuChatId' in metadata && typeof metadata.feishuChatId === 'string' ? metadata.feishuChatId :
    (await db.feishuConversationBinding.findFirst({ where: { liveRoom: { sourceTaskId: taskId }, chatType: 'group' }, select: { chatId: true } }))?.chatId;
  return isFeishuAdmin(input.actorId) || !!chat && await isFeishuGroupAdmin(chat, input.actorId);
}

/** Input remains pending until the original Agent turn binds and seals it. */
export async function reconcileConversationWaits() {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { status: 'attention', node: { status: { in: ['attention', 'claimed'] }, run: { status: { in: ['running', 'attention'] } } } } });
  for (const job of jobs) {
    const inputs = await pendingConversationInputs(prisma, (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } })).runId, job.id);
    if (!inputs.length) continue;
    const { admitNode } = await import('./preparation-recovery');
    await admitNode(job.nodeId, { source: 'conversation', id: inputs.map(input => input.id).join(':'),
      executionIds: [job.id], inputIds: inputs.map(input => input.id) });
  }
}

/** A model can hand back only its own material conversation; admission checks the reservation. */
export async function handoffConversationMaterials(args: { executionId: string; reservationId: string; expectedRevision: number }) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  const { admitNode } = await import('./preparation-recovery');
  return admitNode(job.nodeId, { source: 'materials', id: `conversation-material-handoff:${args.reservationId}`,
    executionIds: [job.id], reservationId: args.reservationId, expectedRevision: args.expectedRevision });
}

const steering = new Map<string, { taskRunId: string; send: HarnessSteer }>();
export function registerConversationSteering(executionId: string, taskRunId: string, send: HarnessSteer) {
  const owner = { taskRunId, send }; steering.set(executionId, owner);
  return () => { if (steering.get(executionId) === owner) steering.delete(executionId); };
}

export async function deliverConversationSteering() {
  for (const [executionId, target] of Array.from(steering.entries())) {
    const inputs = await conversationInputs(executionId);
    const child = inputs.length ? await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, select: { childTaskId: true } }) : null;
    const materials = child?.childTaskId ? await syncGraphConversationMaterials(child.childTaskId) : '';
    for (const input of inputs) {
      const reserved = await prisma.$transaction(async tx => {
        const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
        await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
        const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
        if (job.status !== 'claimed' || job.taskRunId !== target.taskRunId || executionProgress(job.dispatchMetadata)?.phase !== 'implement') return null;
        const key = conversationReceiptKey(input.id) + ':steering';
        if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } })) return null;
        await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'conversation_steering_started', idempotencyKey: key,
          payload: { executionId, inputId: input.id, taskRunId: target.taskRunId } } });
        return job.node.runId;
      });
      if (!reserved) continue;
      const result = await target.send(input.id, conversationPrompt([input]) + '\n' + materials).catch(() => 'unknown' as const);
      if (result === 'unknown') continue;
      await prisma.$transaction(async tx => {
        await tx.taskGraphEvent.create({ data: { runId: reserved, kind: 'conversation_steering_result', idempotencyKey: conversationReceiptKey(input.id) + ':steering:result',
          payload: { executionId, inputId: input.id, taskRunId: target.taskRunId, result } } });
      });
    }
  }
}
