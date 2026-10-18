import { ensureGraphRoomParticipants } from './conversation-members';
import { queueGraphNotification, deliverGraphNotificationOnce } from './notifications';
import { graphTopicDestination } from './repository-topic';
import { cleanupCompletedNodeWorkspaces } from './completed-workspaces';
import { deliverProgressCard } from './progress-card-delivery';
import { prisma } from '../prisma';
import { redactSensitiveText } from '../redact-sensitive';
import { sendFeishuInteractiveMessage } from '../feishu-api';
import { isFeishuAdmin } from '../feishu-access-approval';
import { isFeishuGroupAdmin } from '../feishu-task-entry-api';
import { getFeishuTaskThread, updateFeishuTaskEntryCard } from '../feishu-task-entry-api';
import { confirmFeishuTaskBinding, recordFeishuTaskRoot, reserveFeishuTaskBinding } from '../feishu-task-binding';
import { postLiveRoomMessage } from '../live-room-messages';
import { approveHumanNode, refreshTaskGraphRunStatus, releaseReadyNodes } from './store';

function childCard(title: string, state: 'pending' | 'ready') {
  return {
    config: { wide_screen_mode: true },
    header: { template: state === 'ready' ? 'green' : 'grey', title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: state === 'ready'
      ? '详细进度与验收结论在当前子话题展示。路线摘要与状态入口同步到父任务。'
      : '正在绑定任务话题。' } }],
  };
}

/** Create a group child topic only after the dependency gate has released this execution. */
export async function ensureGraphChildTopic(args: {
  parentTaskId: string; executionId: string; childTaskId: string; title: string; workingDirectory: string;
}) {
  const execution = await prisma.taskGraphExecution.findUnique({ where: { id: args.executionId }, select: { repository: true } });
  const originals = await prisma.feishuTaskBindingRequest.findMany({ where: { sourceMessageId: `task-graph:${args.executionId}` } });
  if (originals.length > 1) throw new Error('Multiple child topic requests require reconciliation');
  const original = originals[0];
  const scope = original ? { appId: original.appId, chatId: original.chatId }
    : await graphTopicDestination(args.parentTaskId, execution?.repository);
  if (!scope) return null;
  const request = await reserveFeishuTaskBinding({
    ...scope, sourceMessageId: `task-graph:${args.executionId}`,
    title: args.title, workingDirectory: args.workingDirectory,
  });
  const maySend = Date.now() - request.createdAt.getTime() < 50 * 60_000;
  let rootMessageId = request.rootMessageId;
  if (!rootMessageId) {
    if (!maySend) throw new Error('Graph child topic send is ambiguous; reconcile the original request');
    rootMessageId = await sendFeishuInteractiveMessage({
      receiveId: scope.chatId, uuid: request.id, card: childCard(args.title, 'pending'),
    }) || null;
    if (!rootMessageId) throw new Error('Feishu did not return a child task root');
    await recordFeishuTaskRoot(scope, request.id, rootMessageId);
  }
  const threadId = await getFeishuTaskThread({ ...scope, rootMessageId, requestId: request.id, mayReply: maySend });
  const binding = await confirmFeishuTaskBinding(scope, request.id, { ...scope, rootMessageId, threadId });
  const room = await prisma.liveRoom.findUniqueOrThrow({ where: { id: binding.liveRoomId } });
  if (room.sourceTaskId && room.sourceTaskId !== args.childTaskId) throw new Error('Graph child topic is bound to another task');
  if (!room.sourceTaskId) {
    await prisma.liveRoom.update({ where: { id: room.id }, data: { sourceTaskId: args.childTaskId } });
  }
  await ensureGraphRoomParticipants(room.id, args.executionId);
  await updateFeishuTaskEntryCard(rootMessageId, childCard(args.title, 'ready'));
  return binding;
}

export async function postGraphParentProgress(parentTaskId: string, runId: string, text: string) {
  const room = await prisma.liveRoom.findFirst({
    where: { sourceTaskId: parentTaskId, status: 'active' }, orderBy: { updatedAt: 'desc' }, select: { id: true },
  });
  if (!room) return;
  await postLiveRoomMessage({
    roomId: room.id, messageType: 'system', content: `系统提示：任务图 ${runId} · ${text}`,
    metadata: { systemEvent: 'task_graph_progress', runId },
  });
}

export async function sendGraphHumanReviewCard(runId: string, nodeKey: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  await queueGraphNotification(runId, `human-review:${node.id}:${node.updatedAt.getTime()}`, { kind: 'human_review', nodeKey });
}

export async function deliverGraphHumanReviewCard(runId: string, nodeKey: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  if (node.status !== 'awaiting_human') return null;
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: run.parentTaskId } }, orderBy: { updatedAt: 'desc' },
  });
  if (!binding) throw new Error('Human review destination is not yet bound');
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `任务图人工验收 · ${nodeKey}` } },
    elements: [
      { tag: 'markdown', content: `运行 ${runId} 的 ${nodeKey} 已完成执行与自动检查。请核对父任务进度和验收证据。` },
      { tag: 'action', actions: ['approve', 'reject'].map((decision) => ({
        tag: 'button', type: decision === 'approve' ? 'primary' : 'danger',
        text: { tag: 'plain_text', content: decision === 'approve' ? '验收通过' : '退回处理' },
        value: { cmd: 'task-graph-decision', runId, nodeKey, decision },
      })) },
    ],
  };
  const messageId = await deliverGraphNotificationOnce({ runId, identity: `human-review:${node.id}`, send: () => sendFeishuInteractiveMessage({
    receiveId: binding.chatId, card,
    ...(binding.rootMessageId ? { threadRootMessageId: binding.rootMessageId } : {}),
    uuid: `task-graph-review-${node.id}`,
  }) });
  if (!messageId) throw new Error('Human review card send returned no message id');
  return messageId;
}

export async function handleGraphHumanReviewCardAction(args: {
  runId: string; nodeKey: string; decision: string; openId: string | null;
  chatId: string | null; messageId: string | null;
}) {
  if (!args.openId || !args.chatId || !args.messageId || !['approve', 'reject'].includes(args.decision)) {
    return { toast: { type: 'warning', content: '验收卡身份信息不完整' } };
  }
  const node = await prisma.taskGraphNode.findUnique({
    where: { runId_key: { runId: args.runId, key: args.nodeKey } },
    include: { run: { select: { parentTaskId: true } } },
  });
  if (!node || node.acceptance !== 'human' || node.status !== 'awaiting_human' || !node.reviewerId) {
    return { toast: { type: 'warning', content: '验收卡已失效或任务状态已变化' } };
  }
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { chatId: args.chatId, liveRoom: { sourceTaskId: node.run.parentTaskId } },
  });
  if (!binding || (!isFeishuAdmin(args.openId) &&
      !(binding.chatType === 'group' && await isFeishuGroupAdmin(args.chatId, args.openId)))) {
    return { toast: { type: 'warning', content: '只有父任务所在群的管理员可验收' } };
  }
  await approveHumanNode({
    runId: args.runId, nodeKey: args.nodeKey, reviewerId: node.reviewerId,
    approved: args.decision === 'approve', note: `飞书管理员 ${args.openId} 在卡片 ${args.messageId} 确认`,
  });
  if (args.decision === 'approve') await cleanupCompletedNodeWorkspaces(args.runId, args.nodeKey);
  const released = args.decision === 'approve' ? await releaseReadyNodes(args.runId) : [];
  await refreshTaskGraphRunStatus(args.runId);
  await postGraphParentProgress(node.run.parentTaskId, args.runId,
    `${args.nodeKey} 人工验收${args.decision === 'approve' ? '通过' : '未通过'}${released.length ? `，放行 ${released.join('、')}` : ''}`);
  return { toast: { type: 'success', content: '验收决定已记录' } };
}

/** Keep integration failures visible in the same topic as the implementation. */
export async function postGraphChildProgress(childTaskId: string, eventKey: string, text: string) {
  const execution = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId }, select: { node: { select: { runId: true } } } });
  await queueGraphNotification(execution.node.runId, `child-progress:${childTaskId}:${eventKey}`, { kind: 'child_progress', childTaskId, eventKey, text });
}

export async function deliverGraphChildProgress(childTaskId: string, eventKey: string, text: string) {
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: childTaskId }, chatType: 'group', rootMessageId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!binding?.rootMessageId) return null;
  const rootMessageId = binding.rootMessageId;
  const run = await prisma.taskRun.findFirst({ where: { taskId: childTaskId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (run) {
    const { relayTaskGraphRunReply } = await import('./run-reply-relay');
    const current = await prisma.taskRunFeishuRelay.findFirst({ where: { bindingId: binding.id },
      orderBy: [{ taskRun: { createdAt: 'desc' } }, { taskRunId: 'desc' }], select: { taskRunId: true } });
    if (!await relayTaskGraphRunReply(current?.taskRunId || run.id, true)) throw new Error('Task progress card is busy; retry delivery');
    return true;
  }
  const detail = redactSensitiveText(text).slice(-10_000);
  const execution = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId }, select: { node: { select: { runId: true } } } });
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`graph-reply-topic:${binding.id}`})) AS locked`;
    if (!lock.locked) return null;
    const existing = await tx.taskRunFeishuRelay.findFirst({ where: { bindingId: binding.id, messageId: { not: null } }, orderBy: { createdAt: 'asc' } });
    return deliverProgressCard({ bindingId: binding.id, runId: execution.node.runId, childTaskId,
      chatId: binding.chatId, rootMessageId, messageId: existing?.messageId,
      card: { schema: '2.0', config: { update_multi: true }, header: { template: 'orange', title: { tag: 'plain_text', content: '任务进度' } },
      body: { elements: [{ tag: 'markdown', content: detail.split('\n')[0].slice(0, 300) },
        { tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '技术详情' } }, elements: [{ tag: 'markdown', content: detail }] }] } } });
  }, { timeout: 25_000 });
}
