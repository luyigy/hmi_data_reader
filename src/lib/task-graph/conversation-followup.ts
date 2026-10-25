import { implementationConversationInputs } from './conversation-routing';
import { admitNode } from './preparation-recovery';
import { deliverConversationDeferredCard } from './conversation-deferred-card';
import { graphGit } from './git-command';
import { graphRunCanStartTx, requireGraphNodeActiveTx } from './run-control';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { executeAcpxTaskRun } from '../acpx/runner';
import { executionProgress, metadataWithProgress } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import { createGraphWriter, parseGraphWriter, observeGraphWriter } from './writer-ownership';
import { bindConversationInputs, conversationInputsByIds, conversationPrompt, conversationHistoryPrompt, pendingConversationInputs, pendingConversationNodes } from './conversation-inbox';
import { conversationContinuation } from './conversation-continuation';
import { conversationTargetKey } from './conversation-target';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';
import { ensureReadOnlyWorkspace } from './readonly-workspace';
import { releaseGraphReviewWorker } from './phase-worker';
import { syncGraphConversationMaterials } from './conversation-materials';

function parseReservation(raw: Prisma.JsonValue) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.executionId !== 'string' ||
    !Array.isArray(raw.inputIds) || !raw.inputIds.every((id): id is string => typeof id === 'string')) throw new Error('Invalid conversation reservation');
  const worker = parseGraphWriter(raw.worker);
  if (!worker) throw new Error('Conversation reservation has no writer identity');
  return { executionId: raw.executionId, inputIds: raw.inputIds, worker };
}

/** Read-only turns retain completed/blocked graph state and cannot perform implementation outcomes. */
export async function bindReadOnlyConversation(tx: Prisma.TransactionClient, args: { executionId: string; reservationId: string; inputIds: string[] }, taskRunId: string) {
  const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  await requireGraphNodeActiveTx(tx, original.nodeId);
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
  const reservation = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: args.reservationId } });
  const binding = parseReservation(reservation.payload);
  const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  const progress = executionProgress(current.dispatchMetadata);
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
  if (![current.childTaskId, `task-graph-review-${current.nodeId}`, `task-graph-architecture-${current.nodeId}`].includes(run.taskId)) throw new Error('Conversation task belongs to another node');
  if (progress?.conversation?.reservationId !== args.reservationId || progress.conversation.kind !== 'reserved' ||
      progress.worker?.nonce !== binding.worker.nonce || ['claimed', 'ready'].includes(current.status)) throw new Error('Conversation reservation ownership changed');
  if (reservation.kind !== 'conversation_followup_reserved' || binding.executionId !== args.executionId ||
    JSON.stringify(binding.inputIds) !== JSON.stringify(args.inputIds)) throw new Error('Invalid conversation reservation');
  await tx.taskGraphEvent.create({ data: { runId: reservation.runId, nodeId: reservation.nodeId,
    idempotencyKey: `conversation-followup:${reservation.id}:run`, kind: 'conversation_followup_bound', payload: { executionId: args.executionId, taskRunId } } });
  const inputs = await conversationInputsByIds(tx, reservation.runId, current.id, args.inputIds);
  if (!inputs.length || inputs.some(input => conversationTargetKey(input.target) !== conversationTargetKey(inputs[0].target))) throw new Error('Conversation reservation mixes target sessions');
  const target = inputs[0].target;
  if ((!target || target.kind === 'implementation') && run.taskId !== current.childTaskId) throw new Error('Legacy conversation belongs to the implementation session');
  if (target?.kind === 'session' && target.role !== 'implementer') {
    if (target.candidateCommit !== (current.commit || progress?.candidateCommit || null)) throw new Error('Conversation review candidate changed');
    await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(run.controlMetadata || '{}'), reviewCandidates: [{ id: current.id, commit: target.candidateCommit }] }) } });
  }
  await bindConversationInputs(tx, args.executionId, args.inputIds, taskRunId);
  await tx.taskGraphExecution.update({ where: { id: current.id }, data: { dispatchMetadata: metadataWithProgress(current.dispatchMetadata,
    { ...progress, conversation: { kind: 'running', reservationId: args.reservationId, taskRunId } }) } });
}

export async function reserveConversationFollowup(nodeId: string) {
  const beforeNode = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId, kind: { in: ['conversation_followup_reserved', 'conversation_followup_bound', 'conversation_followup_finished'] } }, orderBy: { id: 'asc' } });
  const taskRunIds: string[] = beforeNode.executions.flatMap(job => {
    const review = executionProgress(job.dispatchMetadata)?.review;
    return review?.kind === 'running' ? [review.taskRunId] : [];
  });
  for (const event of events.filter(event => event.kind === 'conversation_followup_reserved')) {
    const bound = events.find(item => item.idempotencyKey === `conversation-followup:${event.id}:run`);
    if (bound) {
      const payload = bound.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.taskRunId !== 'string') return null;
      taskRunIds.push(payload.taskRunId);
    } else if (!events.some(item => item.idempotencyKey === `conversation-followup:${event.id}:finished`) &&
      (await observeGraphWriter(parseReservation(event.payload).worker)).kind !== 'exited') return null;
  }
  const proof = await observeWriterSnapshot({ jobs: beforeNode.executions, taskRunIds, scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) return null;
  const worker = await createGraphWriter();
  return prisma.$transaction(async tx => {
    if (!await graphRunCanStartTx(tx, beforeNode.runId)) return null;
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
    if (!await writerSnapshotMatches(tx, proof)) return null;
    const currentEvents = await tx.taskGraphEvent.findMany({ where: { nodeId, kind: { in: ['conversation_followup_reserved', 'conversation_followup_bound', 'conversation_followup_finished'] } }, orderBy: { id: 'asc' } });
    if (!isDeepStrictEqual(currentEvents, events)) return null;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
    if (!isDeepStrictEqual([...node.executions].sort((a, b) => a.id.localeCompare(b.id)), [...proof.jobs].sort((a, b) => a.id.localeCompare(b.id)))) return null;
    for (const job of node.executions) {
      const progress = executionProgress(job.dispatchMetadata);
      if (job.status === 'claimed' || job.status === 'ready') continue;
      const pendingInputs = await pendingConversationInputs(tx, node.runId, job.id);
      const direct = job.status === 'attention' ? await implementationConversationInputs(tx, job, pendingInputs, true) : [];
      const available = pendingInputs.filter(input => input.target?.kind !== 'unresolved' && !direct.some(item => item.id === input.id));
      if (!available.length || !job.childTaskId) continue;
      const previous = await tx.taskGraphEvent.findMany({ where: { runId: node.runId, kind: 'conversation_followup_reserved',
        payload: { path: ['executionId'], equals: job.id } }, orderBy: { createdAt: 'desc' } });
      const batches = Array.from(new Set(available.map(input => input.rootInputId))).map(rootInputId => {
        const pending = available.filter(input => input.rootInputId === rootInputId);
        const batchIdentity = createHash('sha256').update(JSON.stringify({ inputs: [rootInputId], candidate: progress?.candidateCommit,
          state: progress?.state, failure: progress?.lastFailure })).digest('hex');
        const attempts = previous.filter(event => event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload.batchIdentity === batchIdentity);
        return { pending, batchIdentity, attempts };
      });
      const batch = batches.find(batch => batch.attempts.length < 4 && (!batch.attempts[0] || Date.now() - batch.attempts[0].createdAt.getTime() >= 15_000));
      if (!batch) continue;
      const { pending, batchIdentity, attempts } = batch;
      const event = await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id,
        kind: 'conversation_followup_reserved', idempotencyKey: `conversation-followup:${job.id}:${batchIdentity}:${attempts.length}`,
        payload: { executionId: job.id, expectedRevision: progress?.revision, inputIds: pending.map(input => input.id), worker, batchIdentity, attempt: attempts.length + 1 } } });
      if (!progress) throw new Error('Conversation requires versioned execution ownership');
      await tx.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(job.dispatchMetadata,
        { ...progress, revision: progress.revision + 1, worker, workerReleasedAt: undefined,
          conversation: { kind: 'reserved', reservationId: event.id } }) } });
      return { job, event, pending };
    }
    return null;
  });
}

export async function startConversationFollowups(capacity: number) {
  const inputs = await pendingConversationNodes();
  const nodeIds = inputs.map(input => input.nodeId);
  const started: { executionId: string; promise: Promise<void> }[] = [];
  for (const nodeId of nodeIds) {
    if (started.length >= capacity) break;
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
    for (const job of node.executions) {
      if (started.length >= capacity) break;
      if (job.status !== 'attention') continue;
      const inputs = await implementationConversationInputs(prisma, job, await pendingConversationInputs(prisma, node.runId, job.id));
      if (!inputs.length) continue;
      const promise = admitNode(nodeId, { source: 'conversation', id: `conversation:${job.id}:${inputs[0].id}`,
        executionIds: [job.id], inputIds: inputs.map(input => input.id) }).then(() => undefined)
        .catch(error => console.error('[TaskGraph] conversation admission deferred:', { executionId: job.id, error }));
      started.push({ executionId: job.id, promise });
    }
    if (started.length >= capacity || node.executions.some(job => started.some(work => work.executionId === job.id))) continue;
    const reservation = await reserveConversationFollowup(nodeId);
    if (!reservation) continue;
    const work = (async () => {
      const { job, event, pending } = reservation;
      const session = await conversationContinuation(job.id, pending[0]?.target);
      const task = await prisma.task.findUniqueOrThrow({ where: { id: session.taskId } });
      const candidate = job.commit || executionProgress(job.dispatchMetadata)?.candidateCommit;
      const target = pending[0]?.target;
      if (target?.kind === 'session' && target.role !== 'implementer' && target.candidateCommit !== (candidate || null)) throw new Error('原验收会话对应的候选已改变，消息保留在原会话，不能转交新验收者。');
      const directory = target?.kind === 'session' ? session.workingDirectory : candidate ? await ensureReadOnlyWorkspace(job.repository, candidate, job.id) : job.worktreePath;
      if (!directory) throw new Error('Original conversation workspace unavailable; preserve pending input');
      if (target?.kind === 'session' && target.role === 'implementer' && job.status === 'integrated' && candidate &&
        (await graphGit(directory, 'rev-parse', 'HEAD') !== candidate || await graphGit(directory, 'status', '--porcelain', '--untracked-files=all'))) throw new Error('Fixed conversation workspace identity changed');
      const prompt = `你负责原任务，在原会话回答用户。当前是固定成果、角色或授权边界下的只读问答，不进行实施、不发布验收结论。普通消息不能批准资源、扩大范围或重置预算；说明当前边界即可，不要求用户输出恢复口令。\n当前状态：${job.status}\n当前进度：${JSON.stringify(executionProgress(job.dispatchMetadata))}\n${conversationPrompt(pending)}${await conversationHistoryPrompt(job.id, pending)}`;
      const materialPrompt = (session.participant.role === 'implementer' ? prompt : `你在原独立复核会话中回答用户。保持原复核角色与固定候选，不进行实施、不通过聊天发布验收结论。\n${conversationPrompt(pending)}`) + '\n' + await syncGraphConversationMaterials(job.childTaskId!);
      const result = await executeAcpxTaskRun({ graphConversation: { executionId: job.id, reservationId: event.id, inputIds: pending.map(input => input.id) },
        taskId: task.id, taskSessionId: session.taskSessionId, taskName: task.name,
        taskDescription: materialPrompt + session.context, participants: [session.participant], orchestrationMode: 'single',
        workingDirectory: directory, extraReadOnlyPaths: session.extraReadOnlyPaths, permissionConfig: taskGraphAgentReviewPermissionConfig });
      await releaseGraphReviewWorker(job.nodeId, parseReservation(event.payload).worker.nonce);
      if (result.status !== 'completed') throw new Error(`原会话本轮执行失败：${result.summary || result.status}`);
    })().catch(async error => {
      const reason = error instanceof Error ? error.message : String(error);
      await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: reservation.event.runId, idempotencyKey: `${reservation.event.id}:deferred` } }, update: {},
        create: { runId: reservation.event.runId, nodeId: reservation.job.nodeId, kind: 'conversation_followup_deferred', idempotencyKey: `${reservation.event.id}:deferred`,
          payload: { executionId: reservation.job.id, reason, fingerprint: createHash('sha256').update(reason).digest('hex'), inputIds: reservation.pending.map(input => input.id) } } });
      const bound = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: reservation.event.runId, idempotencyKey: `conversation-followup:${reservation.event.id}:run` } } });
      if (!bound && reservation.job.childTaskId) await deliverConversationDeferredCard({ taskId: reservation.job.childTaskId,
        executionId: reservation.job.id, runId: reservation.event.runId, rootInputId: reservation.pending[0].rootInputId, reason })
        .catch(notificationError => console.error('[TaskGraph] conversation defer notification:', notificationError));
    }).finally(async () => {
      await releaseGraphReviewWorker(reservation.job.nodeId, parseReservation(reservation.event.payload).worker.nonce);
      await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: reservation.event.runId, idempotencyKey: `conversation-followup:${reservation.event.id}:finished` } }, update: {},
        create: { runId: reservation.event.runId, nodeId: reservation.job.nodeId, kind: 'conversation_followup_finished', idempotencyKey: `conversation-followup:${reservation.event.id}:finished`, payload: {} } });
    }).catch(error => console.error('[TaskGraph] conversation result persistence failed:', { executionId: reservation.job.id, error }));
    started.push({ executionId: reservation.job.id, promise: work });
  }
  return started;
}
