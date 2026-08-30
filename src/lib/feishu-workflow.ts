import {
  getBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';
import {
  runLiveRoomPlan,
  runLiveRoomWorkflow,
  type LiveRoomWorkflowLevel,
  workflowPlanRevisionPathFrom,
} from '@/lib/live-room-workflows';
import {
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import {
  handleNewSessionCommand,
  prepareWorkflowRotationHandover,
} from '@/lib/feishu-new-session';
import {
  findJob,
  findProjectById,
  loadProjectsConfig,
} from '@/lib/scheduled-jobs/project-config';
import {
  evaluateWorkflowRoomRotation,
  formatWorkflowRotationNotice,
  suggestHandoverPathFromPrompt,
} from '@/lib/workflow-session-rotation';
import {
  buildWorkflowPermissionSnapshot,
  detectWorkflowPermissionDowngrade,
  formatWorkflowPermissionSnapshot,
  validateWorkflowExecutionPolicy,
  workflowPolicySource,
  type WorkflowExecutionPolicy,
  type WorkflowPermissionSnapshot,
} from '@/lib/workflow-execution-policy';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';

export const buildWorkflowExecutionCard = (
  workflowContext: string | undefined,
  prompt: string,
  permissionSnapshot?: WorkflowPermissionSnapshot,
  rotationNotice?: string,
  downgradeNotice?: string,
) => {
  const instruction = workflowContext && prompt.startsWith(`${workflowContext}\n\n`)
    ? prompt.slice(workflowContext.length + 2)
    : prompt;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Workflow · Coding Session' },
    },
    elements: [
      ...(workflowContext ? [{ tag: 'markdown', content: workflowContext }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: instruction },
      ...(downgradeNotice ? [{ tag: 'markdown', content: `**${downgradeNotice}**` }] : []),
      ...(permissionSnapshot
        ? [{ tag: 'markdown', content: `**Workflow permissions**\n${formatWorkflowPermissionSnapshot(permissionSnapshot)}` }]
        : []),
      ...(rotationNotice ? [{ tag: 'markdown', content: `**Session 治理**\n${rotationNotice}` }] : []),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '以上指令已投递给 Coding Agent；请等待本阶段完成后再继续。' }] },
    ],
  };
};

export async function runWorkflowInBoundLiveRoom(args: {
  projectId: string;
  jobId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  workflowContext?: string;
  executionPolicy: WorkflowExecutionPolicy;
  eventKey: string;
  roleWorkflow?: boolean;
  roleWorkflowLevel?: LiveRoomWorkflowLevel;
  roleWorkflowApprovedPlan?: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  args.signal.throwIfAborted();
  const projects = await loadProjectsConfig();
  const project = findProjectById(projects, args.projectId);
  const job = findJob(projects, args.projectId, args.jobId);
  if (!project || !job || job.type !== 'workflow_watcher') {
    throw new Error(`workflow watcher config not found: ${args.projectId}/${args.jobId}`);
  }
  const source = workflowPolicySource(project.id, job.id);
  const executionPolicy = validateWorkflowExecutionPolicy(job.config.execution_policy, source);
  if (JSON.stringify(executionPolicy) !== JSON.stringify(args.executionPolicy)) {
    throw new Error('Workflow execution policy changed before dispatch; retry with current config');
  }
  const permissionSnapshot = buildWorkflowPermissionSnapshot({
    policy: executionPolicy,
    projectPath: project.path,
    source,
  });
  const revisionPath = workflowPlanRevisionPathFrom(args.prompt);
  let dispatch = await prisma.workflowDispatch.upsert({
    where: {
      projectId_jobId_eventKey: {
        projectId: args.projectId,
        jobId: args.jobId,
        eventKey: args.eventKey,
      },
    },
    create: {
      projectId: args.projectId,
      jobId: args.jobId,
      eventKey: args.eventKey,
    },
    update: {},
  });
  if (['reply_queued', 'completed', 'failed'].includes(dispatch.state)) return true;
  if (dispatch.state === 'blocked') {
    throw new Error(`workflow dispatch blocked after unconfirmed Feishu side effect: ${args.eventKey}`);
  }
  args.signal.throwIfAborted();

  const context: FeishuConversationContext = {
    chatId: args.chatId,
    chatType: args.chatType,
    senderOpenId: 'workflow-watcher',
    messageId: `workflow:${args.eventKey}`,
  };
  const boundRoom = await getBoundLiveRoom(context);
  if (!boundRoom?.sourceTask) throw new Error('bound live room has no source task');
  const rotatableMembers = boundRoom.members.filter((member) =>
    member.memberType !== 'user'
    && member.canReply
    && member.harnessType !== 'antigravity');
  const sourceTaskPermission = boundRoom.sourceTask.acpxPermissionConfig;
  const permissionDowngrade = detectWorkflowPermissionDowngrade({
    policy: executionPolicy,
    members: boundRoom.members
      .filter((member) => member.memberType !== 'user')
      .map((member) => ({
        displayName: member.userNickname || member.displayName,
        permission: resolveLiveRoomMemberPermission(
          member.acpxPermissionConfig,
          sourceTaskPermission,
        ),
      })),
  });
  let rotationNotice = '';

  // A committed HANDOVER can be visible before its agent has emitted its final reply.
  // Keep the watcher event pending; the task-completion wakeup will retry it.
  if (dispatch.state === 'prepared') {
    const active = await prisma.taskRun.count({
      where: { taskId: boundRoom.sourceTask.id, status: 'running' },
    });
    if (active) return false;
  }

  if (['rotation_confirmation_posting', 'rotation_confirmation_required'].includes(dispatch.state)) {
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'rotation_pending' },
    });
  }

  if (dispatch.state === 'prepared') {
    const rotation = args.roleWorkflow ? null : await evaluateWorkflowRoomRotation({
      room: boundRoom,
      config: job.config.session_rotation,
    });
    rotationNotice = rotation
      ? formatWorkflowRotationNotice(rotation.decision, rotation.thresholds)
      : 'Slice 边界：为可轮换成员强制启动 fresh Session；同一 Slice 内续聊保持当前 Session。';
    const rotationRequired = Boolean(
      rotatableMembers.length
      && (args.roleWorkflow || rotation?.decision.action === 'rotation_pending'),
    );
    if (!rotationRequired) {
      dispatch = await prisma.workflowDispatch.update({
        where: { id: dispatch.id },
        data: {
          state: rotation?.decision.action === 'prepare_checkpoint'
            ? 'rotation_checkpoint_prepared'
            : 'rotation_not_required',
        },
      });
      if (!rotatableMembers.length && (args.roleWorkflow || rotation?.decision.action === 'rotation_pending')) {
        rotationNotice += ' 房间内没有可换代的持久 Session；Antigravity 仅参与房间告警。';
      }
    } else {
      const workingDirectory = boundRoom.workingDirectory
        || boundRoom.sourceTask.workingDirectory
        || project.path;
      const handover = await prepareWorkflowRotationHandover({
        taskId: boundRoom.sourceTask.id,
        taskName: boundRoom.sourceTask.name,
        roomId: boundRoom.id,
        roomTitle: boundRoom.title,
        workingDirectory,
        memberIds: rotatableMembers.map(({ id }) => id),
        memberNames: rotatableMembers.map((member) => member.userNickname || member.displayName),
        rotationKey: args.eventKey,
        suggestedPath: suggestHandoverPathFromPrompt(args.prompt),
      });
      const claimed = await prisma.workflowDispatch.updateMany({
        where: { id: dispatch.id, state: 'prepared' },
        data: { state: 'rotation_pending' },
      });
      if (!claimed.count) return false;
      dispatch = { ...dispatch, state: 'rotation_pending' };
      const result = await handleNewSessionCommand({
        args: [],
        options: {
          all: 'true',
          blank: 'true',
          confirmed: 'true',
          'rotatable-only': 'true',
          handover,
          'rotation-key': args.eventKey,
          'workflow-event-key': args.eventKey,
        },
      }, context);
      if (!result.startsWith('✅')) throw new Error(`workflow session rotation failed: ${result}`);
      dispatch = await prisma.workflowDispatch.update({
        where: { id: dispatch.id },
        data: { state: 'rotation_completed' },
      });
    }
  } else if (dispatch.state === 'rotation_pending') {
    const workingDirectory = boundRoom.workingDirectory
      || boundRoom.sourceTask.workingDirectory
      || project.path;
    const handover = await prepareWorkflowRotationHandover({
      taskId: boundRoom.sourceTask.id,
      taskName: boundRoom.sourceTask.name,
      roomId: boundRoom.id,
      roomTitle: boundRoom.title,
      workingDirectory,
      memberIds: rotatableMembers.map(({ id }) => id),
      memberNames: rotatableMembers.map((member) => member.userNickname || member.displayName),
      rotationKey: args.eventKey,
      suggestedPath: suggestHandoverPathFromPrompt(args.prompt),
    });
    const result = await handleNewSessionCommand({
      args: [],
      options: {
        all: 'true',
        blank: 'true',
        confirmed: 'true',
        'rotatable-only': 'true',
        handover,
        'rotation-key': args.eventKey,
        'workflow-event-key': args.eventKey,
      },
    }, context);
    if (!result.startsWith('✅')) throw new Error(`workflow session rotation failed: ${result}`);
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'rotation_completed' },
    });
  }

  args.signal.throwIfAborted();
  if ([
    'rotation_not_required',
    'rotation_checkpoint_prepared',
    'rotation_completed',
    'session_reset',
  ].includes(dispatch.state)) {
    rotationNotice ||= dispatch.state === 'rotation_completed'
      ? 'Session 已按 event key 完成换代并恢复 workflow dispatch。'
      : dispatch.state === 'rotation_checkpoint_prepared'
      ? '已记录 checkpoint 准备建议；本次继续复用原 Session。'
      : 'rotation_not_required：本次继续复用原 Session。';
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'blocked' },
    });
    const feishuMessageId = await sendFeishuInteractiveMessage({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      card: buildWorkflowExecutionCard(args.workflowContext, args.prompt, permissionSnapshot, rotationNotice, permissionDowngrade?.notice),
    });
    if (!feishuMessageId) throw new Error('Feishu workflow card response missing message_id');
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'feishu_posted', feishuMessageId },
    });
  }

  args.signal.throwIfAborted();
  const room = await getBoundLiveRoom(context);
  const userMember = room?.members.find((member) => member.memberType === 'user');
  if (!room || !userMember) throw new Error('bound live room has no user member');

  if (dispatch.state === 'feishu_posted') {
    const existingMessage = await prisma.liveRoomMessage.findFirst({
      where: {
        roomId: room.id,
        metadata: { contains: `"eventKey":${JSON.stringify(args.eventKey)}` },
      },
      orderBy: { createdAt: 'desc' },
    });
    const message = existingMessage ?? await postLiveRoomMessage({
        roomId: room.id,
        senderMemberId: userMember.id,
        content: args.prompt,
        messageType: 'user',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'user',
          extras: {
            source: 'workflow_watcher',
            eventKey: args.eventKey,
            workflowPermissionSnapshot: permissionSnapshot,
            ...(permissionDowngrade
              ? {
                workflowPermissionDowngrade: {
                  members: permissionDowngrade.members,
                  notice: permissionDowngrade.notice,
                  policy: executionPolicy.preset,
                },
              }
              : {}),
          },
        }),
      });
    dispatch = await prisma.workflowDispatch.update({
      where: { id: dispatch.id },
      data: { state: 'prompt_posted', roomId: room.id, messageId: message.id },
    });
  }

  args.signal.throwIfAborted();
  if (!dispatch.messageId) throw new Error('workflow dispatch has no prompt message');
  const existingDelivery = await prisma.liveRoomDelivery.findFirst({
    where: { roomMessageId: dispatch.messageId },
    select: { id: true },
  });
  if (!existingDelivery) {
    if (revisionPath) {
      const claimed = await prisma.workflowDispatch.updateMany({
        where: { id: dispatch.id, state: 'prompt_posted' },
        data: { state: 'reply_queued' },
      });
      if (!claimed.count) return true;
      void runLiveRoomPlan({
        roomId: room.id,
        sourceMessageId: dispatch.messageId,
        content: `/plan --revise=${revisionPath} ${args.prompt}`,
      }).catch(async (error) => {
        console.error('[workflow] PLAN revision failed to start', error);
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：PLAN 修订启动失败：${error instanceof Error ? error.message : String(error)}`,
          messageType: 'system',
        }).catch(() => undefined);
      });
      return true;
    } else if (args.roleWorkflow) {
      const claimed = await prisma.workflowDispatch.updateMany({
        where: { id: dispatch.id, state: 'prompt_posted' },
        data: { state: 'reply_queued' },
      });
      if (!claimed.count) return true;
      void runLiveRoomWorkflow({
        roomId: room.id,
        sourceMessageId: dispatch.messageId,
        name: 'feature',
        level: args.roleWorkflowLevel,
        approvedPlan: args.roleWorkflowApprovedPlan,
        task: args.prompt,
      }).catch(async (error) => {
        console.error('[workflow] role workflow failed to start', error);
        await prisma.workflowDispatch.updateMany({
          where: { id: dispatch.id, state: 'reply_queued' },
          data: { state: 'failed' },
        }).catch((updateError) => console.error('[workflow] failed to finalize role workflow dispatch', updateError));
        await postLiveRoomMessage({
          roomId: room.id,
          content: `系统提示：角色串行工作流启动失败：${error instanceof Error ? error.message : String(error)}`,
          messageType: 'system',
        }).catch(() => undefined);
      });
      return true;
    } else {
      await triggerLiveRoomMessageReplies({
        roomId: room.id,
        roomMessageId: dispatch.messageId,
        requestedTargetMemberId: null,
        waitForCompletion: false,
        allowHandoff: false,
      });
    }
  }
  args.signal.throwIfAborted();
  await prisma.workflowDispatch.update({
    where: { id: dispatch.id },
    data: { state: 'reply_queued' },
  });
  return true;
}
