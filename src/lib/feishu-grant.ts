import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import {
  buildAcpxPermissionConfigForProfile,
} from '@/lib/acpx/permissions';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import { findLatestParticipantSession } from '@/lib/acpx/session-tracking';
import { executeAcpxTaskRunWithContinuationFallback } from '@/lib/acpx/continuation-retry';
import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { buildLiveRoomAcpxParticipant } from '@/lib/live-room';

export type GrantProfile = 'dev_local' | 'full_access';

type GrantActionPayload = {
  roomId: string;
  memberId?: string | null;
  profile: GrantProfile;
  exp: number;
};

function getGrantSigningSecret() {
  return (
    process.env.FEISHU_APP_SECRET?.trim()
    || process.env.FEISHU_ENCRYPT_KEY?.trim()
    || 'agent-platform-feishu-grant'
  );
}

function encodePayload(payload: GrantActionPayload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as GrantActionPayload;
}

export function createGrantActionToken(payload: Omit<GrantActionPayload, 'exp'> & { ttlMs?: number }) {
  const fullPayload: GrantActionPayload = {
    roomId: payload.roomId,
    memberId: payload.memberId ?? null,
    profile: payload.profile,
    exp: Date.now() + (payload.ttlMs ?? 15 * 60 * 1000),
  };
  const encoded = encodePayload(fullPayload);
  const signature = crypto
    .createHmac('sha256', getGrantSigningSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyGrantActionToken(token: string): GrantActionPayload | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) {
    return null;
  }

  const expected = crypto
    .createHmac('sha256', getGrantSigningSecret())
    .update(encoded)
    .digest('base64url');
  if (signature !== expected) {
    return null;
  }

  const payload = decodePayload(encoded);
  if (!payload.exp || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

export function parseGrantProfile(value: string | null | undefined): GrantProfile | null {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) {
    return null;
  }

  if (['dev', 'developer', 'dev_local', 'dev-local'].includes(normalized)) {
    return 'dev_local';
  }

  if (['full', 'full_access', 'full-access'].includes(normalized)) {
    return 'full_access';
  }

  return null;
}

export function buildGrantPermissionConfig(
  profile: GrantProfile,
  currentWritableRoots: string[]
): AcpxPermissionConfig {
  return buildAcpxPermissionConfigForProfile(profile, currentWritableRoots);
}

const resolveRoomMember = (room: {
  members: Array<{
    id: string;
    displayName: string;
    userNickname: string | null;
    shortAlias: string | null;
    memberType: string;
    canReply: boolean;
    backend?: string | null;
    harnessType?: string | null;
    gatewayId?: string | null;
    gateway?: {
      id: string;
      name: string;
    } | null;
    runtimeAgentId?: string | null;
    acpxPermissionConfig?: string | null;
  }>;
  currentSpeakerMemberId: string | null;
}, args: { memberId?: string | null; query?: string | null }) => {
  const replyableMembers = room.members.filter((member) => member.memberType !== 'user' && member.canReply);

  if (args.memberId) {
    return replyableMembers.find((member) => member.id === args.memberId) || null;
  }

  const normalizedQuery = args.query?.trim().replace(/^[@$]/, '').toLowerCase() || '';
  if (!normalizedQuery) {
    return (
      replyableMembers.find((member) => member.id === room.currentSpeakerMemberId)
      || replyableMembers[0]
      || null
    );
  }

  return replyableMembers.find((member) =>
    `${member.displayName} [${member.id.slice(-8)}]`.toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase() === normalizedQuery
    || (member.userNickname || '').toLowerCase() === normalizedQuery
    || (member.shortAlias || '').toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase().includes(normalizedQuery)
    || member.id.endsWith(normalizedQuery)
  ) || null;
};

export async function grantRightsForRoom(args: {
  roomId: string;
  profile: GrantProfile;
  memberId?: string | null;
  memberQuery?: string | null;
  message?: string | null;
}) {
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

  if (!room || !room.sourceTask) {
    throw new Error('当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法授权。');
  }

  const member = resolveRoomMember(room, {
    memberId: args.memberId,
    query: args.memberQuery,
  });
  if (!member) {
    throw new Error(args.memberQuery ? `找不到目标成员：${args.memberQuery}` : '当前房间没有可授权的 agent 成员。');
  }

  const participant = buildLiveRoomAcpxParticipant({
    id: member.id,
    displayName: member.displayName,
    backend: member.backend,
    harnessType: member.harnessType,
    gatewayId: member.backend === 'remote_ssh'
      ? (member.gateway?.id || member.gatewayId)
      : member.gatewayId,
    gatewayName: member.gateway?.name || null,
    runtimeAgentId: member.runtimeAgentId,
  });

  const currentPermissionConfig = resolveLiveRoomMemberPermission(
    member.acpxPermissionConfig,
    room.sourceTask.acpxPermissionConfig
  );

  const nextPermissionConfig = buildGrantPermissionConfig(
    args.profile,
    currentPermissionConfig.writableRoots
  );

  await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: { acpxPermissionConfig: JSON.stringify(nextPermissionConfig) },
  });

  const taskRoom = await ensureTaskChatRoom(room.sourceTask.id, room.sourceTask.name);
  const targetParticipantKey = getTaskRoomParticipantTargetKey(participant);
  const targetParticipantLabel = getTaskRoomParticipantTargetLabel(participant);
  const continuationMessage =
    args.message?.trim()
    || (
      args.profile === 'full_access'
        ? '我已授予你完全权限。请继续刚才的任务；当前可以直接修改工作区、联网，并在必要时使用更高本地权限。'
        : '我已授予你开发权限。请继续刚才的任务；当前可以写工作区并联网，优先直接验证和修复问题。'
    );

  await postTaskRoomMessage({
    roomId: taskRoom.id,
    content: continuationMessage,
    userId: 'task-room-user',
    userName: '用户',
    targetType: 'participant',
    targetParticipantKey,
    targetParticipantLabel,
  });

  const latestSession = await findLatestParticipantSession(room.sourceTask.id, participant);
  const runResult = await executeAcpxTaskRunWithContinuationFallback({
    staleParticipantId: latestSession?.participant?.id || null,
    request: {
      taskId: room.sourceTask.id,
      taskSessionId: room.sourceTask.currentTaskSession?.id || undefined,
      taskName: room.sourceTask.name,
      taskDescription: room.sourceTask.description || undefined,
      orchestrationMode: 'single',
      workingDirectory: room.sourceTask.workingDirectory || undefined,
      permissionConfig: nextPermissionConfig,
      participants: [
        latestSession?.continuationSessionId
          ? {
              ...participant,
              resumeSessionId: latestSession.continuationSessionId,
              resumeThreadId:
                latestSession.continuationSessionKind === 'codex_thread'
                  ? latestSession.continuationSessionId
                  : undefined,
              continuationSessionKind: latestSession.continuationSessionKind || undefined,
              continuationMessage,
            }
          : {
              ...participant,
              continuationMessage,
              ephemeralSession: true,
            },
      ],
    },
  });

  return {
    member,
    room,
    taskRunId: runResult.taskRunId,
    usedContinuation: Boolean(latestSession?.continuationSessionId),
    profile: args.profile,
  };
}
