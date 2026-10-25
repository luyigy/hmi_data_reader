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
import { createGraphWriter, parseGraphWriter, observeGraphWriter, observeTaskRunWriter } from './writer-ownership';
import { bindConversationInputs, conversationInputsByIds, conversationPrompt, conversationHistoryPrompt, pendingConversationInputs, pendingConversationNodes, handoffConversationMaterials } from './conversation-inbox';
import { conversationContinuation } from './conversation-continuation';
import { conversationTargetKey } from './conversation-target';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';
import { ensureReadOnlyWorkspace } from './readonly-workspace';
import { releaseGraphReviewWorker } from './phase-worker';
import { syncGraphConversationMaterials } from './conversation-materials';
import { postGraphChildProgress } from './feishu';

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
      const available = (await pendingConversationInputs(tx, node.runId, job.id)).filter(input => input.target?.kind !== 'unresolved');
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
      const prompt = `你负责原任务，继续在这个话题与用户正常交流。结合前几轮图片、说明和纠正核对事实；旧的缺材料判断可以被新证据纠正，不能当成不可改变的要求。先直接回答用户。仅当本轮用户明确要求恢复实施时，简短说明接下来做什么，再附加一行 TASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["本任务当前或历史材料消息id"],"note":"继续实施的依据"}。询问原因、补充信息、否定恢复均只回答，不输出恢复动作。“现在能否恢复执行”等可行性询问也只评估并回答，即使条件具备也不等于用户要求立即执行。材料可以引用本任务前几轮已处理的消息，不要求用户重发。平台根据本轮用户身份核验接续权限，并在原会话交回实施。准备接续不代表材料已通过独立验收。当前阶段保护固定成果，源码只读；平台确认 writer 退出并完成交接后，实施轮次才能写入。不能通过聊天扩大范围、放宽权限、重置预算或宣布任务通过。\n当前状态：${job.status}\n当前进度：${JSON.stringify(executionProgress(job.dispatchMetadata))}\n${conversationPrompt(pending)}${await conversationHistoryPrompt(job.id, pending)}`;
      const materialPrompt = (session.participant.role === 'implementer' ? prompt : `你在原独立复核会话中回答用户。保持原复核角色与固定候选，不进行实施、不通过聊天发布验收结论。\n${conversationPrompt(pending)}`) + '\n' + await syncGraphConversationMaterials(job.childTaskId!);
      const result = await executeAcpxTaskRun({ graphConversation: { executionId: job.id, reservationId: event.id, inputIds: pending.map(input => input.id) },
        taskId: task.id, taskSessionId: session.taskSessionId, taskName: task.name,
        taskDescription: materialPrompt + session.context, participants: [session.participant], orchestrationMode: 'single',
        workingDirectory: directory, extraReadOnlyPaths: session.extraReadOnlyPaths, permissionConfig: taskGraphAgentReviewPermissionConfig });
      await releaseGraphReviewWorker(job.nodeId, parseReservation(event.payload).worker.nonce);
      if (result.status !== 'completed') throw new Error(`原会话本轮执行失败：${result.summary || result.status}`);
      if (session.participant.role !== 'implementer') return;
      const matches = Array.from((result.participants[0]?.summary || result.summary || '').matchAll(/^TASK_GRAPH_CONVERSATION\s+(\{[^\n]+\})\s*$/gm));
      if (result.status === 'completed' && matches.length === 1) {
        let action: unknown;
        try { action = JSON.parse(matches[0][1]); }
        catch {
          await postGraphChildProgress(task.id, `conversation:invalid-action:${event.id}`, '原执行者本轮已经答复，但恢复建议格式无效，平台未执行恢复；原消息与交付状态保留。');
          return;
        }
        const before = executionProgress(job.dispatchMetadata);
        if (action && typeof action === 'object' && 'action' in action && action.action === 'resume_implementation' && 'inputIds' in action && Array.isArray(action.inputIds) && action.inputIds.length > 0 && action.inputIds.every((id): id is string => typeof id === 'string') &&
          before && ['waiting_decision', 'waiting_for_user', 'exhausted'].includes(before.state)) {
          const ids = Array.from(new Set(action.inputIds));
          const cited = ids.length <= 50 ? await prisma.taskGraphEvent.count({ where: {
            id: { in: ids }, runId: event.runId, nodeId: job.nodeId, kind: 'conversation_input',
            payload: { path: ['executionId'], equals: job.id },
          } }) : 0;
          if (cited !== ids.length) {
            await postGraphChildProgress(task.id, `conversation:material-reference-declined:${event.id}`,
              '接续建议引用的材料无法在本任务会话中核实。平台保留本轮输入和原进度，尚未安排恢复。');
            return;
          }
          const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
          const progress = executionProgress(current.dispatchMetadata);
          if (progress?.revision === before.revision + 2 && progress.state === before.state && progress.candidateCommit === before.candidateCommit &&
            progress.lastFailure?.code === before.lastFailure?.code) {
            const result = await handoffConversationMaterials({ executionId: job.id, reservationId: event.id, expectedRevision: progress.revision });
            if (result.kind !== 'admitted' && result.kind !== 'already_scheduled') await postGraphChildProgress(task.id, `conversation:handoff-declined:${event.id}`,
              `本轮答复已保留，实施尚未接续：${result.reason}。`);
          } else await postGraphChildProgress(task.id, `conversation:handoff-declined:${event.id}`,
            '恢复建议对应的任务版本或阶段已改变，平台未启动旧版本的实施；原答复和消息保留。');
        }
      }
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
