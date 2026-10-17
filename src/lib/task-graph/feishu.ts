import { ensureGraphRoomParticipants } from './conversation-members';
import { cleanupCompletedNodeWorkspaces } from './completed-workspaces';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { redactSensitiveText } from '../redact-sensitive';
import { replyFeishuMessage, sendFeishuInteractiveMessage } from '../feishu-api';
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
      ? '任务已放行，Agent 在独立 Git worktree 执行。进度与验收结论会同步到父任务话题。'
      : '正在绑定任务话题。' } }],
  };
}

/** Create a group child topic only after the dependency gate has released this execution. */
export async function ensureGraphChildTopic(args: {
  parentTaskId: string; executionId: string; childTaskId: string; title: string; workingDirectory: string;
}) {
  const parent = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: args.parentTaskId }, chatType: 'group', appId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!parent?.appId) return null;
  const scope = { appId: parent.appId, chatId: parent.chatId };
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
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: run.parentTaskId } }, orderBy: { updatedAt: 'desc' },
  });
  if (!binding) return null;
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  if (node.status !== 'awaiting_human') return null;
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
  return sendFeishuInteractiveMessage({
    receiveId: binding.chatId, card,
    ...(binding.rootMessageId ? { threadRootMessageId: binding.rootMessageId } : {}),
    uuid: `task-graph-review-${node.id}`,
  });
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
  const binding = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: childTaskId }, rootMessageId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!binding?.rootMessageId) return null;
  return replyFeishuMessage({ messageId: binding.rootMessageId, msgType: 'text',
    content: { text: redactSensitiveText(text).slice(-10_000) }, replyInThread: true,
    uuid: `graph-child-${createHash('sha256').update(`${childTaskId}:${eventKey}`).digest('hex').slice(0, 32)}` });
}
