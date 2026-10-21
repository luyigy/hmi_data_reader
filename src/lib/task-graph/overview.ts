import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { redactSensitiveText } from '../redact-sensitive';
import { receiveGraphTaskMessageTx } from './conversation-inbox';
import { executionProgress } from './execution-progress';
import { deliverGraphNotificationOnce } from './notifications';
import { postGraphChildProgress } from './feishu';
import { setGraphRunPaused } from './run-control';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (runId: string) => `graph-overview:${runId}`;
const receiptKey = (runId: string) => `notification-message:${hash(identity(runId))}`;
const labels: Record<string, string> = { planned: '等待前置', ready: '准备执行', claimed: '工作中', verifying: '独立验收中',
  passed: '验收通过', attention: '现场保留', delivered_unverified: '实施已交付，未独立验收', awaiting_human: '等待人工验收' };

export async function loadGraphOverview(runId: string) {
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, include: { nodes: {
    orderBy: { createdAt: 'asc' }, include: { executions: true },
  } } });
  const binding = await prisma.feishuConversationBinding.findFirst({ where: { liveRoom: { sourceTaskId: run.parentTaskId }, appId: { not: null } }, orderBy: { updatedAt: 'desc' } });
  const control = await prisma.taskGraphEvent.findFirst({ where: { runId, kind: { in: ['run_user_paused', 'run_user_resumed'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const taskRunIds = run.nodes.flatMap(node => node.executions.flatMap(job => job.taskRunId ? [job.taskRunId] : []));
  const nativeTurns = await prisma.taskRun.findMany({ where: { id: { in: taskRunIds } }, select: { id: true, summary: true, status: true } });
  const liveOutputs = await prisma.taskRunEvent.findMany({ where: { taskRunId: { in: taskRunIds }, eventType: 'stdout_chunk' },
    distinct: ['taskRunId'], orderBy: [{ taskRunId: 'asc' }, { sequence: 'desc' }], select: { taskRunId: true, content: true } });
  return { run, binding, nativeTurns, liveOutputs, controlVersion: control?.id || 'initial' };
}

export function buildGraphOverview(data: Awaited<ReturnType<typeof loadGraphOverview>>, requestedPage = 0) {
  const { run, controlVersion } = data, size = 6, pages = Math.max(1, Math.ceil(run.nodes.length / size));
  const page = Math.max(0, Math.min(Number.isInteger(requestedPage) ? requestedPage : 0, pages - 1));
  const nodes = run.nodes.slice(page * size, (page + 1) * size);
  const callback = (text: string, action: string, targetPage = page) => ({ tag: 'button', text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value: { cmd: 'task-graph-overview', action, runId: run.id, hash: run.snapshotHash, controlVersion, page: targetPage } }] });
  const rows = nodes.map(node => {
    const details = node.executions.map(job => {
      const progress = executionProgress(job.dispatchMetadata);
      const failure = progress && ['exhausted', 'ownership_attention', 'waiting_decision'].includes(progress.state) ? progress.lastFailure?.detail : '';
      const note = progress?.waitingMessage || failure || data.nativeTurns.find(turn => turn.id === job.taskRunId)?.summary
        || data.liveOutputs.find(output => output.taskRunId === job.taskRunId)?.content || progress?.lastFailure?.detail || '';
      const waiting = progress?.state === 'waiting_for_user' ? ' · 原 Agent 等待输入或干预' : '';
      return `${job.key} · ${job.agentSelector}${waiting}\n${redactSensitiveText(note).replace(/^TASK_GRAPH_IMPLEMENTATION.*$/gm, '').slice(-700)}`;
    }).join('\n');
    return { tag: 'markdown', content: `**${node.key} · ${labels[node.status] || node.status}**${node.dependsOn.length ? ` · 前置 ${node.dependsOn.join('、')}` : ''}\n${details}` };
  });
  const targets = nodes.flatMap(node => node.executions.filter(job => job.childTaskId).map(job => ({ text: { tag: 'plain_text', content: `${node.key}/${job.key}` }, value: job.id })));
  return { schema: '2.0', config: { update_multi: true }, header: { template: run.status === 'paused' ? 'orange' : 'blue',
    title: { tag: 'plain_text', content: `任务总览 V${run.version} · ${run.status === 'paused' ? '用户已暂停' : run.status.startsWith('completed') ? '路线已结束' : run.status === 'attention' ? '有任务等待输入或处理' : '按依赖推进'} · ${page + 1}/${pages}` } },
  body: { elements: [
    { tag: 'markdown', content: 'Agent 自主实施与提问。回复会送回所选原 Agent；实施已提交与独立验收通过分别展示。' }, ...rows,
    ...(targets.length ? [{ tag: 'form', name: 'ticket_reply', elements: [
      { tag: 'select_static', name: 'execution', width: 'fill', required: true, placeholder: { tag: 'plain_text', content: '回复哪个任务？' }, options: targets },
      { tag: 'input', name: 'reply', required: true, placeholder: { tag: 'plain_text', content: '给原 Agent 的回答或补充' } },
      { tag: 'button', name: `tgo:r:${run.id}:${run.snapshotHash}`, form_action_type: 'submit', text: { tag: 'plain_text', content: run.status === 'paused' ? '保存回复，保持暂停' : '发送给原 Agent' } },
    ] }] : []),
    callback('刷新', 'page'), ...(page ? [callback('上一页', 'page', page - 1)] : []), ...(page + 1 < pages ? [callback('下一页', 'page', page + 1)] : []),
    callback(run.status === 'paused' ? '明确继续此路线' : '暂停此路线', run.status === 'paused' ? 'resume' : 'pause'),
  ] } };
}

export async function publishGraphOverview(runId: string) {
  const data = await loadGraphOverview(runId);
  if (!data.binding) return false;
  const destination = { bindingId: data.binding.id, chatId: data.binding.chatId, rootMessageId: data.binding.rootMessageId, appId: data.binding.appId };
  const bound = await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: 'overview:destination' } }, update: {},
    create: { runId, kind: 'overview_destination', idempotencyKey: 'overview:destination', payload: destination } });
  if (!isDeepStrictEqual(bound.payload, destination)) throw new Error('Overview destination changed; reconcile the original card');
  const previous = await prisma.taskGraphEvent.findFirst({ where: { runId, kind: 'overview_rendered' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const payload = previous?.payload;
  const page = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.page === 'number' ? payload.page : 0;
  const card = buildGraphOverview(data, page), viewHash = hash(JSON.stringify(card));
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.hash === viewHash) return false;
  const receipt = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: receiptKey(runId) } } });
  const sent = receipt?.payload;
  if (sent && typeof sent === 'object' && !Array.isArray(sent) && typeof sent.messageId === 'string') await updateFeishuTaskEntryCard(sent.messageId, card);
  else await deliverGraphNotificationOnce({ runId, identity: identity(runId), send: () => sendFeishuInteractiveMessage({
    receiveId: data.binding!.chatId, card, uuid: hash(identity(runId)).slice(0, 48),
    ...(data.binding!.rootMessageId ? { threadRootMessageId: data.binding!.rootMessageId } : {}),
  }) });
  await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: `overview-rendered:${hash((previous?.id || 'initial') + ':' + viewHash)}` } }, update: {},
    create: { runId, kind: 'overview_rendered', idempotencyKey: `overview-rendered:${hash((previous?.id || 'initial') + ':' + viewHash)}`, payload: { hash: viewHash, page } } });
  return true;
}

/** SDK verifies the event envelope; recheck operator, exact parent card and Ticket ownership here. */
export async function handleGraphOverviewAction(args: { value: Record<string, unknown>; form: Record<string, unknown>; openId: string | null;
  chatId: string | null; messageId: string | null; callbackId: string }) {
  const { runId, action, hash: snapshotHash } = args.value;
  if (typeof runId !== 'string' || typeof snapshotHash !== 'string' || typeof action !== 'string' || !['reply', 'page', 'pause', 'resume'].includes(String(action)) || !args.callbackId) throw new Error('Invalid overview action');
  const data = await loadGraphOverview(runId);
  const receipt = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: receiptKey(runId) } } });
  const sent = receipt?.payload;
  if (snapshotHash !== data.run.snapshotHash || !data.binding || data.binding.chatId !== args.chatId || !sent || typeof sent !== 'object' || Array.isArray(sent) || sent.messageId !== args.messageId) throw new Error('Overview card identity changed');
  const destination = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: 'overview:destination' } } });
  if (!isDeepStrictEqual(destination?.payload, { bindingId: data.binding.id, chatId: data.binding.chatId, rootMessageId: data.binding.rootMessageId, appId: data.binding.appId })) throw new Error('Overview destination changed');
  if (!args.openId || !isFeishuAdmin(args.openId) && !(data.binding.chatType === 'group' && await isFeishuGroupAdmin(data.binding.chatId, args.openId))) throw new Error('Only the task operator can reply or control this route');
  const requestId = hash(args.callbackId), actorId = args.openId;
  if (action === 'pause' || action === 'resume') {
    if (typeof args.value.controlVersion !== 'string') throw new Error('Missing user-control version');
    await setGraphRunPaused({ runId, paused: action === 'pause', actorId, requestId, reason: 'Feishu overview user control', expectedControl: args.value.controlVersion });
  } else if (action === 'page') {
    const page = typeof args.value.page === 'number' ? args.value.page : 0;
    const card = buildGraphOverview(data, page);
    await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: `overview-page:${requestId}` } }, update: {},
      create: { runId, kind: 'overview_rendered', idempotencyKey: `overview-page:${requestId}`, payload: { page } } });
    return { toast: { type: 'success' as const, content: '进度已刷新' }, card: { type: 'raw' as const, data: card } };
  } else {
    const executionId = args.form.execution, text = args.form.reply;
    if (typeof executionId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('Select a Ticket and enter a reply');
    const content = redactSensitiveText(text.trim());
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'overview-input:' + requestId}, 0))`;
      const key = { runId, idempotencyKey: `overview-input:${requestId}` };
      const old = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: key } });
      if (old) {
        const saved = old.payload;
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.executionId !== executionId || saved.actorId !== actorId || saved.content !== content) throw new Error('Overview callback identity reused');
        return { taskId: typeof saved.taskId === 'string' ? saved.taskId : '', eventId: old.id };
      }
      const job = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: true } });
      if (job.node.runId !== runId || !job.childTaskId) throw new Error('Reply target is outside this route');
      const room = await tx.liveRoom.findFirst({ where: { sourceTaskId: job.childTaskId, status: 'active' } });
      if (!room) throw new Error('Original Ticket room is not ready');
      const sourceId = `overview:${requestId}`;
      const metadata = JSON.stringify({ source: 'feishu', feishuSenderOpenId: actorId, feishuMessageId: sourceId, feishuChatId: args.chatId,
        overviewRunId: runId, overviewMessageId: args.messageId });
      const message = await tx.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content, metadata } });
      if (!await receiveGraphTaskMessageTx(tx, { taskId: job.childTaskId, sourceId: `feishu:${sourceId}`, actorId, actorOrigin: 'feishu', content, roomMessageId: message.id, sourceMetadata: metadata })) throw new Error('Ticket input ownership changed');
      const event = await tx.taskGraphEvent.create({ data: { ...key, nodeId: job.nodeId, kind: 'overview_input_received', payload: { executionId, taskId: job.childTaskId, actorId, content, roomMessageId: message.id } } });
      return { taskId: job.childTaskId, eventId: event.id };
    });
    await postGraphChildProgress(result.taskId, `conversation:overview-reply:${result.eventId}`, `用户从总览回复：\n${content}`);
  }
  return { toast: { type: 'success' as const, content: action === 'reply' ? '已送入原 Agent 会话；暂停中的路线保持暂停' : action === 'pause' ? '已暂停派发，正在核对进程退出' : '已明确继续，原安全保护仍有效' } };
}

export async function relayGraphOverviews() {
  const runs = await prisma.taskGraphRun.findMany({ where: { OR: [{ status: { in: ['running', 'attention', 'paused'] } },
    { status: { in: ['completed', 'completed_unverified'] }, updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } }] }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
  for (const run of runs) await publishGraphOverview(run.id).catch(error => console.error('[TaskGraphOverview] delivery deferred', { runId: run.id, detail: error instanceof Error ? error.message : String(error) }));
}
