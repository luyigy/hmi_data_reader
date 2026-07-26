import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prisma } from '@/lib/prisma';
import { rotateTaskSession } from '@/lib/acpx/session';
import { parseGrantProfile } from '@/lib/feishu-grant';
import {
  normalizeAcpxPermissionConfig,
  DEFAULT_ACPX_PERMISSION_CONFIG,
} from '@/lib/acpx/permissions';
import {
  buildTaskRoomPromptContext,
  ensureTaskChatRoom,
  postTaskRoomMessage,
  postTaskRoomSessionResetMarker,
} from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { buildLiveRoomAcpxParticipant } from '@/lib/live-room';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-delivery';
import {
  cancelQueuedLiveRoomMemberExecutions,
  waitForLiveRoomMemberExecutionStop,
} from '@/lib/live-room-process-registry';
import {
  getBoundLiveRoom,
  resolveRoomMemberQuery,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';

type NewSessionCommand = {
  command?: string;
  args: string[];
  options: Record<string, string>;
};

function resolveHandoverPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const relativePath = trimmed.startsWith('docs/') ? trimmed : path.posix.join('docs', trimmed);
  return {
    relativePath,
    absolutePath: path.join(process.cwd(), relativePath),
  };
}

function buildNewSessionPrompt(args: {
  handoverPath?: string | null;
  handoverContent?: string | null;
  latestUserMessage?: string | null;
  transcript?: string | null;
  memberName: string;
  taskName: string;
  blankBootstrap?: boolean;
  initializeOnly?: boolean;
}) {
  if (args.initializeOnly) {
    return [
      `Start a fresh session for ${args.memberName} on task "${args.taskName}".`,
      args.handoverPath
        ? `Read ${args.handoverPath} as context.`
        : 'Use the supplied room/task state only as context.',
      'Briefly confirm the fresh session is ready.',
      'Do not continue the task, run tools, or modify files until the user sends a new instruction.',
      ...(args.handoverContent ? ['', 'Handover content:', args.handoverContent] : []),
      ...(!args.handoverContent && args.transcript ? ['', 'Recent task-room transcript:', args.transcript] : []),
    ].join('\n');
  }

  if (args.handoverPath && args.handoverContent) {
    return [
      `Read the handover file at ${args.handoverPath} first.`,
      'Then do exactly these three things:',
      '1. Summarize the current state.',
      '2. Confirm the next step.',
      '3. Continue the work in a fresh session.',
      '',
      'Handover content:',
      args.handoverContent,
    ].join('\n');
  }

  if (args.blankBootstrap) {
    return [
      `Start a fresh blank session for ${args.memberName} on task "${args.taskName}".`,
      'Do not assume prior room/task transcript unless the user provides it again.',
      'Wait for the next user instruction and only act on that new instruction.',
    ].join('\n');
  }

  return [
    `Start a fresh session for ${args.memberName} on task "${args.taskName}".`,
    'There is no explicit handover file for this restart.',
    'Use the current room/task state below as the bootstrap context.',
    'Then do exactly these three things:',
    '1. Summarize the current state.',
    '2. Confirm the next step.',
    '3. Continue the work in a fresh session.',
    '',
    'Latest user message:',
    args.latestUserMessage || '(none)',
    '',
    'Recent task-room transcript:',
    args.transcript || '(no transcript available)',
  ].join('\n');
}

function isTruthyFeishuOption(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

export function parseNewSessionProfile(value: string | null | undefined): 'safe_local' | 'dev_local' | 'full_access' | null {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) {
    return null;
  }

  if (['safe', 'safe_local', 'safe-local', 'local'].includes(normalized)) {
    return 'safe_local';
  }

  return parseGrantProfile(normalized);
}

function buildNewSessionPermissionConfig(
  currentPermissionConfig: ReturnType<typeof normalizeAcpxPermissionConfig>,
  requestedProfile: 'safe_local' | 'dev_local' | 'full_access' | null
) {
  if (!requestedProfile) {
    return currentPermissionConfig;
  }

  if (requestedProfile === 'safe_local') {
    return normalizeAcpxPermissionConfig({
      profile: 'safe_local',
      sandboxMode: 'workspace-write',
      networkAccess: 'restricted',
      approvalPolicy: 'never',
      writableRoots: currentPermissionConfig.writableRoots,
    });
  }

  return normalizeAcpxPermissionConfig({
    profile: requestedProfile,
    sandboxMode: requestedProfile === 'full_access' ? 'danger-full-access' : 'workspace-write',
    networkAccess: 'enabled',
    approvalPolicy: 'on-request',
    writableRoots: currentPermissionConfig.writableRoots,
  });
}

export function formatPermissionProfileLabel(profile: string) {
  return profile === 'full_access'
    ? 'Full Access'
    : profile === 'dev_local'
    ? 'Dev Local'
    : profile === 'safe_local'
    ? 'Safe Local'
    : profile;
}

export async function handleNewSessionCommand(command: NewSessionCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法启动 new session。';
  }
  const sourceTask = room.sourceTask;

  const handoverOption = (command.options['handover'] || command.options['from-handover'] || '').trim();
  const memberQuery = (command.options['agent'] || command.args.join(' ') || '').trim();
  const allMembers = isTruthyFeishuOption(command.options['all']) || memberQuery.toLowerCase() === 'all';
  const members = allMembers
    ? room.members.filter((member) => member.memberType !== 'user' && member.canReply)
    : [resolveRoomMemberQuery({ room, query: memberQuery })].filter((member) => member !== null);
  if (!members.length) {
    return memberQuery
      ? `找不到目标成员：${memberQuery}`
      : '当前房间没有可启动 new session 的 agent 成员。';
  }
  const member = members[0];

  const handoverPath = resolveHandoverPath(handoverOption);
  const blankBootstrap =
    isTruthyFeishuOption(command.options['blank'])
    || isTruthyFeishuOption(command.options['no-bootstrap'])
    || isTruthyFeishuOption(command.options['no_bootstrap']);
  let handoverContent: string | null = null;
  if (handoverOption) {
    if (!handoverPath) {
      return 'handover 路径为空。';
    }

    try {
      await fs.access(handoverPath.absolutePath);
    } catch {
      return `找不到 handover 文件：${handoverPath.relativePath}`;
    }

    handoverContent = await fs.readFile(handoverPath.absolutePath, 'utf8');
  }
  const participants = members.map((targetMember) => buildLiveRoomAcpxParticipant({
    id: targetMember.id,
    displayName: targetMember.displayName,
    backend: targetMember.backend,
    harnessType: targetMember.harnessType,
    gatewayId: targetMember.backend === 'remote_ssh'
      ? (targetMember.gateway?.id || targetMember.gatewayId)
      : targetMember.gatewayId,
    gatewayName: targetMember.gateway?.name || null,
    runtimeAgentId: targetMember.runtimeAgentId,
  }));
  const currentPermissionConfig = (() => {
    try {
      return normalizeAcpxPermissionConfig(
        JSON.parse(room.sourceTask.acpxPermissionConfig || 'null')
      );
    } catch {
      return DEFAULT_ACPX_PERMISSION_CONFIG;
    }
  })();
  const requestedProfile =
    parseNewSessionProfile(command.options['profile'])
    || parseNewSessionProfile(command.options['rights'])
    || parseNewSessionProfile(command.options['permission'])
    || parseNewSessionProfile(command.options['access']);
  const permissionConfig = buildNewSessionPermissionConfig(currentPermissionConfig, requestedProfile);
  let interruptedPreviousReplies = false;

  if (requestedProfile && permissionConfig.profile !== currentPermissionConfig.profile) {
    await prisma.task.update({
      where: { id: room.sourceTask.id },
      data: {
        acpxPermissionConfig: JSON.stringify(permissionConfig),
      },
    });
  }

  const taskRoom = await ensureTaskChatRoom(room.sourceTask.id, room.sourceTask.name);
  const promptContext = blankBootstrap
    ? { transcript: '', latestUserMessage: null }
    : await buildTaskRoomPromptContext(room.sourceTask.id, room.sourceTask.name, 30);
  await Promise.all(members.map(async (targetMember) => {
    cancelQueuedLiveRoomMemberExecutions(targetMember.id);
    try {
      const interruption = await interruptLiveRoomMemberReplies({
        roomId: room.id,
        memberId: targetMember.id,
        controlAction: 'stop_run',
      });
      interruptedPreviousReplies =
        interruptedPreviousReplies
        || interruption.interruptedRunningCount > 0
        || interruption.cancelledQueuedCount > 0;
    } catch (error) {
      console.warn('Failed to interrupt previous live room replies before new session:', error);
    }
  }));
  await Promise.all(members.map((targetMember) =>
    waitForLiveRoomMemberExecutionStop(targetMember.id)));

  const freshTaskSession = await rotateTaskSession(room.sourceTask.id, {
    taskName: room.sourceTask.name,
    metadata: {
      source: 'feishu_new_session',
      workflowEventKey: command.options['workflow-event-key'] || null,
      handoverPath: handoverPath?.relativePath || null,
      targetMemberId: allMembers ? null : member.id,
      targetMemberName: allMembers ? 'all' : member.userNickname || member.displayName,
    },
  });
  await postTaskRoomSessionResetMarker({
    roomId: taskRoom.id,
    sessionId: freshTaskSession.id,
    reason: allMembers ? 'new-session' : `new-session:${member.id}`,
  });
  await prisma.liveRoomMemberSession.updateMany({
    where: {
      roomId: room.id,
      memberId: { in: members.map((targetMember) => targetMember.id) },
    },
    data: {
      threadId: null,
      status: 'online',
      lastError: 'reset_by_new_session',
      lastHeartbeatAt: new Date(),
    },
  }).catch(() => undefined);
  await Promise.all(members.map(async (targetMember, index) => {
    const participant = participants[index];
    const targetParticipantKey = getTaskRoomParticipantTargetKey(participant);
    const targetParticipantLabel = getTaskRoomParticipantTargetLabel(participant);
    const prompt = buildNewSessionPrompt({
      handoverPath: handoverPath?.relativePath || null,
      handoverContent,
      latestUserMessage: promptContext.latestUserMessage?.content || null,
      transcript: promptContext.transcript,
      memberName: targetMember.userNickname || targetMember.displayName,
      taskName: sourceTask.name,
      blankBootstrap,
      initializeOnly: allMembers,
    });
    for (const content of [
      handoverPath
        ? `[new-session] ${targetMember.userNickname || targetMember.displayName} <- ${handoverPath.relativePath}`
        : blankBootstrap
        ? `[new-session] ${targetMember.userNickname || targetMember.displayName} <- blank bootstrap`
        : `[new-session] ${targetMember.userNickname || targetMember.displayName} <- room-state bootstrap`,
      prompt,
    ]) {
      await postTaskRoomMessage({
        roomId: taskRoom.id,
        content,
        userId: 'task-room-user',
        userName: '用户',
        targetType: 'participant',
        targetParticipantKey,
        targetParticipantLabel,
      });
    }
  }));

  return [
    `✅ 已为 ${allMembers ? `全部 ${members.length} 个 agent` : member.userNickname || member.displayName} 重置 session`,
    `Bootstrap：${handoverPath?.relativePath ? `handover ${handoverPath.relativePath}` : blankBootstrap ? 'blank' : 'room/task state'}`,
    `请求权限：${formatPermissionProfileLabel(permissionConfig.profile)}`,
    '说明：旧运行和排队消息已停止；Agent 会在下一条真实指令到来时启动新 session。',
    ...(interruptedPreviousReplies ? ['说明：检测到并中断了未完成的旧运行或排队消息。'] : []),
  ].join('\n');
}
