import { isDeepStrictEqual } from 'node:util';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../prisma';
import { executeAcpxTaskRun } from '../acpx/runner';
import type { AcpxParticipantRequest } from '../acpx/types';
import { executionProgress, metadataWithProgress } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import { createGraphWriter, parseGraphWriter, observeGraphWriter, observeTaskRunWriter } from './writer-ownership';
import { bindConversationInputs, conversationPrompt, pendingConversationInputs, pendingConversationNodes, handoffConversationMaterials } from './conversation-inbox';
import { implementationConversation } from './conversation-session';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';
import { graphGit } from './git-command';
import { withRepositoryLock } from './repository-lock';
import { approvedConversationParticipant } from './conversation-members';
import { releaseGraphReviewWorker } from './phase-worker';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { syncGraphConversationMaterials } from './conversation-materials';
import { postGraphChildProgress } from './feishu';

function parseReservation(raw: Prisma.JsonValue) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.executionId !== 'string' ||
    !Array.isArray(raw.inputIds) || !raw.inputIds.every((id): id is string => typeof id === 'string')) throw new Error('Invalid conversation reservation');
  const worker = parseGraphWriter(raw.worker);
  if (!worker) throw new Error('Conversation reservation has no writer identity');
  return { executionId: raw.executionId, inputIds: raw.inputIds, worker };
}

async function conversationWorkspace(repository: string, commit: string) {
  const directory = path.join(path.dirname(repository), '.agent-platform-conversation-worktrees', createHash('sha256').update(`${repository}:${commit}`).digest('hex'));
  return withRepositoryLock(repository, async () => {
    if (!await fs.access(directory).then(() => true, () => false)) {
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await graphGit(repository, 'worktree', 'add', '--detach', directory, commit);
    }
    if (await graphGit(directory, 'rev-parse', 'HEAD') !== commit || await graphGit(directory, 'status', '--porcelain', '--untracked-files=all') ||
      await graphGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== await graphGit(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw new Error('Fixed conversation workspace identity changed');
    return directory;
  });
}

/** Read-only turns retain completed/blocked graph state and cannot perform implementation outcomes. */
export async function bindReadOnlyConversation(tx: Prisma.TransactionClient, args: { executionId: string; reservationId: string; inputIds: string[] }, taskRunId: string) {
  const original = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
  const reservation = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: args.reservationId } });
  const binding = parseReservation(reservation.payload);
  const current = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  const progress = executionProgress(current.dispatchMetadata);
  if (progress?.conversation?.reservationId !== args.reservationId || progress.conversation.kind !== 'reserved' ||
      progress.worker?.nonce !== binding.worker.nonce || ['claimed', 'ready'].includes(current.status)) throw new Error('Conversation reservation ownership changed');
  if (reservation.kind !== 'conversation_followup_reserved' || binding.executionId !== args.executionId ||
    JSON.stringify(binding.inputIds) !== JSON.stringify(args.inputIds)) throw new Error('Invalid conversation reservation');
  await tx.taskGraphEvent.create({ data: { runId: reservation.runId, nodeId: reservation.nodeId,
    idempotencyKey: `conversation-followup:${reservation.id}:run`, kind: 'conversation_followup_bound', payload: { executionId: args.executionId, taskRunId } } });
  await bindConversationInputs(tx, args.executionId, args.inputIds, taskRunId);
  await tx.taskGraphExecution.update({ where: { id: current.id }, data: { dispatchMetadata: metadataWithProgress(current.dispatchMetadata,
    { ...progress, conversation: { kind: 'running', reservationId: args.reservationId, taskRunId } }) } });
}

export async function reserveConversationFollowup(nodeId: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId, kind: { in: ['conversation_followup_reserved', 'conversation_followup_bound', 'conversation_followup_finished'] } }, orderBy: { id: 'asc' } });
  const taskRunIds: string[] = [];
  for (const event of events.filter(event => event.kind === 'conversation_followup_reserved')) {
    const bound = events.find(item => item.idempotencyKey === `conversation-followup:${event.id}:run`);
    if (bound) {
      const payload = bound.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.taskRunId !== 'string') return null;
      taskRunIds.push(payload.taskRunId);
    } else if (!events.some(item => item.idempotencyKey === `conversation-followup:${event.id}:finished`) &&
      (await observeGraphWriter(parseReservation(event.payload).worker)).kind !== 'exited') return null;
  }
  const proof = await observeWriterSnapshot({ jobs: node.executions, taskRunIds, scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) return null;
  const worker = await createGraphWriter();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${nodeId} FOR UPDATE`;
    if (!await writerSnapshotMatches(tx, proof)) return null;
    const currentEvents = await tx.taskGraphEvent.findMany({ where: { nodeId, kind: { in: ['conversation_followup_reserved', 'conversation_followup_bound', 'conversation_followup_finished'] } }, orderBy: { id: 'asc' } });
    if (!isDeepStrictEqual(currentEvents, events)) return null;
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true } });
    if (!isDeepStrictEqual([...node.executions].sort((a, b) => a.id.localeCompare(b.id)), [...proof.jobs].sort((a, b) => a.id.localeCompare(b.id)))) return null;
    for (const job of node.executions) {
      const progress = executionProgress(job.dispatchMetadata);
      if (job.status === 'claimed' || job.status === 'ready' || progress?.state === 'waiting_for_user') continue;
      const pending = await pendingConversationInputs(tx, node.runId, job.id);
      if (!pending.length || !job.childTaskId) continue;
      const previous = await tx.taskGraphEvent.findMany({ where: { runId: node.runId, kind: 'conversation_followup_reserved',
        payload: { path: ['executionId'], equals: job.id } }, orderBy: { createdAt: 'desc' } });
      const batchIdentity = createHash('sha256').update(JSON.stringify({ inputs: Array.from(new Set(pending.map(input => input.rootInputId))).sort(), candidate: progress?.candidateCommit,
        state: progress?.state, failure: progress?.lastFailure })).digest('hex');
      const attempts = previous.filter(event => event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload.batchIdentity === batchIdentity);
      if (attempts.length >= 2 || attempts[0] && Date.now() - attempts[0].createdAt.getTime() < 15_000) return null;
      const event = await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id,
        kind: 'conversation_followup_reserved', idempotencyKey: `conversation-followup:${job.id}:${batchIdentity}:${attempts.length}`,
        payload: { executionId: job.id, inputIds: pending.map(input => input.id), worker, batchIdentity, attempt: attempts.length + 1 } } });
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
      const task = await prisma.task.findUniqueOrThrow({ where: { id: job.childTaskId! } });
      const participant: AcpxParticipantRequest = approvedConversationParticipant(job.launchConfig);
      const candidate = job.commit || executionProgress(job.dispatchMetadata)?.candidateCommit;
      const directory = candidate ? await conversationWorkspace(job.repository, candidate) : job.worktreePath;
      if (!directory) throw new Error('Original conversation workspace unavailable; preserve pending input');
      const prompt = `你负责原任务，继续在这个话题与用户正常交流。结合前几轮图片、说明和纠正核对事实；旧的缺材料判断可以被新证据纠正，不能当成不可改变的要求。先直接回答用户。需要接回实施时，简短说明接下来做什么，再附加一行 TASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["本任务当前或历史材料消息id"],"note":"继续实施的依据"}。材料可以引用本任务前几轮已处理的消息，不要求用户重发。平台根据本轮用户身份核验接续权限，并在原会话交回实施。准备接续不代表材料已通过独立验收。当前阶段保护固定成果，源码只读；平台确认 writer 退出并完成交接后，实施轮次才能写入。不能通过聊天扩大范围、放宽权限、重置预算或宣布任务通过。\n当前状态：${job.status}\n当前进度：${JSON.stringify(executionProgress(job.dispatchMetadata))}\n${conversationPrompt(pending)}`;
      const materialPrompt = prompt + '\n' + await syncGraphConversationMaterials(task.id);
      const session = await implementationConversation(job.id, participant, materialPrompt);
      const result = await executeAcpxTaskRun({ graphConversation: { executionId: job.id, reservationId: event.id, inputIds: pending.map(input => input.id) },
        taskId: task.id, taskSessionId: session.taskSessionId, taskName: task.name,
        taskDescription: materialPrompt + session.context, participants: [session.participant], orchestrationMode: 'single',
        workingDirectory: directory, permissionConfig: taskGraphAgentReviewPermissionConfig });
      await releaseGraphReviewWorker(job.nodeId, parseReservation(event.payload).worker.nonce);
      if (result.status !== 'completed') throw new Error(`原会话本轮执行失败：${result.summary || result.status}`);
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
          before?.state === 'waiting_decision' && ['missing_business_material', 'missing_upstream_input'].includes(before.lastFailure?.code || '')) {
          const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: event.runId }, include: { parentTask: true } });
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
          let authorized = pending.length > 0;
          for (const input of pending) {
            let sourceAuthorized = false;
            let metadata: unknown = null;
            try { metadata = JSON.parse(input.sourceMetadata || 'null'); } catch { /* Non-Feishu input uses the authenticated task owner. */ }
            if (input.actorOrigin === 'feishu') {
              const chat = metadata && typeof metadata === 'object' && 'feishuChatId' in metadata && typeof metadata.feishuChatId === 'string' ? metadata.feishuChatId :
                (await prisma.feishuConversationBinding.findFirst({ where: { liveRoom: { sourceTaskId: job.childTaskId }, chatType: 'group' }, select: { chatId: true } }))?.chatId;
              sourceAuthorized = isFeishuAdmin(input.actorId) || !!chat && await isFeishuGroupAdmin(chat, input.actorId);
            } else if (input.actorOrigin === 'platform') {
              sourceAuthorized = !!run.parentTask.ownerUserId && input.actorId === run.parentTask.ownerUserId ||
                (await prisma.user.findUnique({ where: { id: input.actorId }, select: { role: true } }))?.role === 'admin';
            }
            authorized &&= sourceAuthorized;
          }
          const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
          const progress = executionProgress(current.dispatchMetadata);
          if (authorized && progress?.revision === before.revision + 2 && progress.state === before.state && progress.candidateCommit === before.candidateCommit &&
            progress.lastFailure?.code === before.lastFailure?.code) {
            await handoffConversationMaterials({ executionId: job.id, reservationId: event.id, expectedRevision: progress.revision });
          } else await postGraphChildProgress(task.id, `conversation:handoff-declined:${event.id}`, authorized
            ? '恢复建议对应的任务版本或阶段已改变，平台未启动旧版本的实施；原答复和消息保留。'
            : '本批消息包含没有任务恢复权限的发言，平台保留原材料暂停。任务管理员可在原话题确认材料，接回原执行者。');
        }
      }
    })().catch(async error => {
      const reason = error instanceof Error ? error.message : String(error);
      await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: reservation.event.runId, idempotencyKey: `${reservation.event.id}:deferred` } }, update: {},
        create: { runId: reservation.event.runId, nodeId: reservation.job.nodeId, kind: 'conversation_followup_deferred', idempotencyKey: `${reservation.event.id}:deferred`,
          payload: { executionId: reservation.job.id, reason, fingerprint: createHash('sha256').update(reason).digest('hex'), inputIds: reservation.pending.map(input => input.id) } } });
      if (reservation.job.childTaskId) await postGraphChildProgress(reservation.job.childTaskId, `conversation:deferred:${reservation.event.id}`,
        `本轮会话处理未完成：${reason.slice(0, 300)}。消息和原工作保留；同批输入最多尝试两次，间隔至少15秒，未恢复时由平台核对上述原因。`)
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
