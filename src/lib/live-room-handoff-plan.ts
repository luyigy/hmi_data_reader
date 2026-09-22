import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { isFeishuRoomBoundToChat } from '@/lib/feishu-live-room';
import {
  buildLiveRoomAcpxParticipant,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import { planPathFrom, selectLiveRoomPlanHost } from '@/lib/live-room-workflows';
import { prisma } from '@/lib/prisma';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HANDOFF_PLAN_JOB_ID = 'live_room_handoff_plan';

type HandoffTranscriptMessage = {
  id: string;
  handoffRootMessageId: string | null;
  content: string;
  messageType: string;
  metadata: string | null;
  senderMember: { displayName: string } | null;
};

export const handoffPlanEventKey = (roomId: string, rootMessageId: string) =>
  `handoff-plan:${roomId}:${rootMessageId}`;

export const selectLiveRoomHandoffTranscript = (
  messages: HandoffTranscriptMessage[],
  rootMessageId: string,
) => messages.filter((message) => {
  const metadata = parseLiveRoomMessageMetadata(message.metadata);
  return message.id === rootMessageId
    || message.handoffRootMessageId === rootMessageId
    || metadata?.handoffRootMessageId === rootMessageId;
});

export const formatLiveRoomHandoffTranscript = (messages: HandoffTranscriptMessage[]) =>
  messages.map((message) =>
    `[${message.senderMember?.displayName || (message.messageType === 'system' ? '系统' : '用户')}]\n${message.content}`,
  ).join('\n\n');

const findCompletedPromotion = async (messageId?: string | null) => {
  if (!messageId) return null;
  const message = await prisma.liveRoomMessage.findUnique({
    where: { id: messageId },
    select: { metadata: true },
  });
  const metadata = parseLiveRoomMessageMetadata(message?.metadata);
  return typeof metadata?.planPath === 'string' ? metadata.planPath : null;
};

const findPromotionReceipt = async (roomId: string, eventKey: string) => {
  const messages = await prisma.liveRoomMessage.findMany({
    where: { roomId, messageType: 'system' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, metadata: true },
  });
  for (const message of messages) {
    const metadata = parseLiveRoomMessageMetadata(message.metadata);
    if (metadata?.eventKey === eventKey && typeof metadata.planPath === 'string') {
      return { id: message.id, planPath: metadata.planPath };
    }
  }
  return null;
};

const findCommittedPromotion = async (workingDirectory: string, eventKey: string) => {
  const log = await execFileAsync('git', [
    'log', '-50', '--format=%H', '--fixed-strings', `--grep=Handoff-Plan-Event: ${eventKey}`,
  ], { cwd: workingDirectory });
  const commit = log.stdout.trim().split('\n')[0];
  if (!commit) return null;
  const changed = await execFileAsync('git', [
    'show', '--format=', '--name-only', '--diff-filter=AM', commit,
  ], { cwd: workingDirectory });
  return changed.stdout.split('\n').map((value) => value.trim()).find((value) =>
    /^docs\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[0-9]{3}_PLAN_[^/\s]+\.md$/.test(value),
  ) || null;
};

const recordPromotionReceipt = async (args: {
  dispatchId: string;
  eventKey: string;
  planPath: string;
  roomId: string;
  rootMessageId: string;
}) => {
  const existing = await findPromotionReceipt(args.roomId, args.eventKey);
  const receipt = existing || await postLiveRoomMessage({
    roomId: args.roomId,
    content: `系统提示：Handoff 已提升为审批 PLAN：${args.planPath}。workflow validator 通过后会发送现有审批卡；批准前不会实施。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: {
        systemEvent: 'handoff_plan_committed',
        eventKey: args.eventKey,
        handoffRootMessageId: args.rootMessageId,
        planPath: args.planPath,
      },
    }),
  });
  await prisma.workflowDispatch.update({
    where: { id: args.dispatchId },
    data: { state: 'reply_queued', messageId: receipt.id },
  });
  return args.planPath;
};

export async function promoteLiveRoomHandoffToPlan(args: {
  roomId: string;
  rootMessageId: string;
  context: FeishuConversationContext;
  onStarted?: () => void;
}) {
  // The card value carries a client-visible roomId: never trust it directly.
  // Load the room server-side and require a persisted binding between that room
  // and the chat the card was clicked in (task threads share the group chat id).
  const room = await prisma.liveRoom.findUnique({
    where: { id: args.roomId },
    include: {
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });
  if (!room || !room.sourceTask
    || !await isFeishuRoomBoundToChat({
      roomId: args.roomId,
      chatId: args.context.chatId,
      appId: args.context.appId,
    })) {
    return '当前飞书会话与该 Handoff 房间不匹配，未生成 PLAN。';
  }

  const eventKey = handoffPlanEventKey(args.roomId, args.rootMessageId);
  const dispatch = await prisma.workflowDispatch.upsert({
    where: {
      projectId_jobId_eventKey: {
        projectId: room.sourceTask.id,
        jobId: HANDOFF_PLAN_JOB_ID,
        eventKey,
      },
    },
    create: {
      projectId: room.sourceTask.id,
      jobId: HANDOFF_PLAN_JOB_ID,
      eventKey,
      roomId: room.id,
    },
    update: {},
  });

  if (dispatch.state === 'reply_queued') {
    const planPath = await findCompletedPromotion(dispatch.messageId);
    return planPath
      ? `该 Handoff 已生成审批 PLAN：${planPath}。请使用现有审批卡处理。`
      : '该 Handoff 已生成审批 PLAN，请使用现有审批卡处理。';
  }
  const existingReceipt = await findPromotionReceipt(room.id, eventKey);
  if (existingReceipt) {
    await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'reply_queued', messageId: existingReceipt.id },
    });
    return `该 Handoff 已生成审批 PLAN：${existingReceipt.planPath}。请使用现有审批卡处理。`;
  }
  const recoveredPlanPath = await findCommittedPromotion(
    room.sourceTask.workingDirectory || process.cwd(),
    eventKey,
  );
  if (recoveredPlanPath) {
    await recordPromotionReceipt({
      dispatchId: dispatch.id,
      eventKey,
      planPath: recoveredPlanPath,
      roomId: room.id,
      rootMessageId: args.rootMessageId,
    });
    return `已恢复该 Handoff 的审批 PLAN：${recoveredPlanPath}。等待现有审批卡。`;
  }
  const claimed = await prisma.workflowDispatch.updateMany({
    where: { id: dispatch.id, state: { in: ['prepared', 'failed'] } },
    data: { state: 'running' },
  });
  if (!claimed.count) {
    return '该 Handoff 的 PLAN 正在生成；重复点击不会创建第二份。';
  }
  args.onStarted?.();

  try {
    const allMessages = await prisma.liveRoomMessage.findMany({
      where: { roomId: room.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        handoffRootMessageId: true,
        content: true,
        messageType: true,
        metadata: true,
        senderMember: { select: { displayName: true } },
      },
    });
    const messages = selectLiveRoomHandoffTranscript(allMessages, args.rootMessageId);
    if (!messages.some((message) => message.id === args.rootMessageId)
      || !messages.some((message) => message.messageType === 'assistant')) {
      throw new Error('找不到完整的根 Handoff 讨论链');
    }

    const selected = selectLiveRoomPlanHost(
      room.members.filter((member) => member.memberType !== 'user' && member.canReply),
    );
    if ('error' in selected) throw new Error(selected.error);
    const host = selected.host;
    const workingDirectory = room.sourceTask.workingDirectory || process.cwd();
    const result = await executeAcpxTaskRun({
      taskId: room.sourceTask.id,
      taskSessionId: room.sourceTask.currentTaskSession?.id || undefined,
      taskName: room.sourceTask.name,
      taskDescription: [
        'Promote the supplied Live Room handoff discussion into one approval PLAN.',
        'Do not restart the discussion. Do not implement, test, start a Slice, or restart services.',
        'Read docs/workflow/workflow-contract.yaml from HEAD before writing.',
        'Create one unique docs/NNN_PLAN_YYYYMMDD_*.md with contract-valid frontmatter:',
        'doc_type: PLAN, doc_status: ready, next_action: start_first_slice, plan_kind: phase.',
        `Include this exact provenance marker: <!-- HANDOFF_PLAN_SOURCE: ${args.rootMessageId} -->`,
        'Before creating a file, search the working tree for that exact marker; if one matching draft exists, finish and reuse it.',
        'Synthesize scope, decisions, risks, validation, and an exact workflow prompt from this transcript.',
        'End with exactly one line: PLAN_PATH: docs/<filename>',
        `Root handoff transcript:\n${formatLiveRoomHandoffTranscript(messages)}`,
      ].join('\n\n'),
      orchestrationMode: 'single',
      participants: [{
        ...buildLiveRoomAcpxParticipant({
          ...host,
          gatewayName: host.gateway?.name || null,
        }),
        role: 'plan:handoff-promotion',
      }],
      workingDirectory,
      permissionConfig: resolveLiveRoomMemberPermission(
        host.acpxPermissionConfig,
        room.sourceTask.acpxPermissionConfig,
      ),
    });
    const stage = result.participants[0];
    if (stage?.status !== 'completed') {
      throw new Error(stage?.error || '主持 Agent 未完成 PLAN 生成');
    }
    const planPath = planPathFrom(stage.summary || '');
    if (!planPath) throw new Error('主持 Agent 未返回合法 PLAN_PATH');
    const planContent = await fs.readFile(`${workingDirectory}/${planPath}`, 'utf8');
    if (!planContent.includes(`<!-- HANDOFF_PLAN_SOURCE: ${args.rootMessageId} -->`)) {
      throw new Error('PLAN 缺少根 Handoff 来源标记');
    }
    const tracked = await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', planPath], {
      cwd: workingDirectory,
    });
    if (tracked.stdout.trim()) throw new Error(`主持 Agent 试图覆盖已有 PLAN：${planPath}`);

    await execFileAsync('git', ['add', '--', planPath], { cwd: workingDirectory });
    await execFileAsync('git', [
      'commit', '--only',
      '-m', `docs: add plan from handoff ${args.rootMessageId.slice(-8)}`,
      '-m', `Handoff-Plan-Event: ${eventKey}`,
      '--', planPath,
    ], { cwd: workingDirectory });
    await recordPromotionReceipt({
      dispatchId: dispatch.id,
      eventKey,
      planPath,
      roomId: room.id,
      rootMessageId: args.rootMessageId,
    });
    return `审批 PLAN 已提交：${planPath}。等待 workflow validator 和现有审批卡。`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'failed' },
    });
    await postLiveRoomMessage({
      roomId: room.id,
      content: `系统提示：Handoff 提升 PLAN 失败：${reason}。修复后可再次点击；不会绕过审批。`,
      messageType: 'system',
    });
    return `Handoff 提升 PLAN 失败：${reason}`;
  }
}

export function handleLiveRoomHandoffPlanCardAction(args: {
  value: Record<string, unknown>;
  openId?: string;
  chatId?: string;
  messageId?: string;
  prefix: string;
  onStarted?: () => void;
}) {
  if (!args.openId || !args.chatId
    || typeof args.value.roomId !== 'string'
    || typeof args.value.rootMessageId !== 'string') {
    return { toast: { type: 'warning', content: 'Handoff PLAN 按钮已失效' } };
  }
  // Reject forged cross-room cards before any work starts: the room must be
  // bound to the chat the card was clicked in.
  return isFeishuRoomBoundToChat({ roomId: args.value.roomId, chatId: args.chatId })
    .then((bound) => {
      if (!bound) {
        return { toast: { type: 'warning', content: '当前飞书会话与该 Handoff 房间不匹配' } };
      }
      void promoteLiveRoomHandoffToPlan({
        roomId: args.value.roomId as string,
        rootMessageId: args.value.rootMessageId as string,
        context: {
          chatId: args.chatId!,
          chatType: args.value.chatType === 'p2p' ? 'p2p' : 'group',
          senderOpenId: args.openId!,
          messageId: args.messageId || '',
        },
        onStarted: args.onStarted,
      }).catch((err) => {
        console.error(`${args.prefix} handoff PLAN promotion failed`, { err });
      });
      return { toast: { type: 'success', content: '已开始生成审批 PLAN；重复点击不会创建第二份' } };
    })
    .catch((err) => {
      console.error(`${args.prefix} handoff PLAN room validation failed`, { err });
      return { toast: { type: 'warning', content: 'Handoff PLAN 按钮已失效' } };
    });
}
