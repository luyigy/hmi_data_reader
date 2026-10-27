import { graphMemberPermissionTask } from './task-graph/room-permission-task';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import {
  buildAcpxPermissionConfigForProfile,
  DEFAULT_ACPX_PERMISSION_CONFIG,
  getPermissionProfileLabel,
  normalizeAcpxPermissionConfig,
} from './acpx/permissions';
import type { AcpxPermissionConfig } from './acpx/types';

export type LiveRoomPermissionProfile = 'safe_local' | 'dev_local' | 'full_access';

export const resolveLiveRoomMemberPermission = (
  memberValue?: string | null,
  fallbackValue?: string | null
): AcpxPermissionConfig => {
  for (const value of [memberValue, fallbackValue]) {
    try {
      if (value) return normalizeAcpxPermissionConfig(JSON.parse(value));
    } catch {
      // Fall through to the inherited/default permission.
    }
  }
  return DEFAULT_ACPX_PERMISSION_CONFIG;
};

export const permissionConfigForProfile = (
  profile: LiveRoomPermissionProfile,
  writableRoots: string[] = []
) => buildAcpxPermissionConfigForProfile(profile, writableRoots);

export const formatLiveRoomPermissionLabel = (value?: string | null) =>
  getPermissionProfileLabel(resolveLiveRoomMemberPermission(null, value).profile);

export const setLiveRoomMemberPermission = async (
  roomId: string,
  memberId: string,
  profile: LiveRoomPermissionProfile
) => {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "LiveRoom" WHERE id = ${roomId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "LiveRoomMember" WHERE id = ${memberId} FOR UPDATE`;
    const member = await tx.liveRoomMember.findFirst({ where: { id: memberId, roomId, canReply: true }, include: { room: true } });
    if (!member) throw new Error('Member not found');
    const task = await graphMemberPermissionTask(tx, member, member.room.sourceTaskId);
    const config = permissionConfigForProfile(profile,
      resolveLiveRoomMemberPermission(member.acpxPermissionConfig, task?.acpxPermissionConfig).writableRoots);
    await tx.liveRoomMember.update({ where: { id: member.id }, data: { acpxPermissionConfig: JSON.stringify(config) } });
    const job = member.room.sourceTaskId ? await tx.taskGraphExecution.findUnique({ where: { childTaskId: member.room.sourceTaskId }, include: { node: true } }) : null;
    if (job) await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'room_member_permission_changed',
      idempotencyKey: `room-permission:${member.id}:${randomUUID()}`, payload: { memberId: member.id, roomId,
        before: member.acpxPermissionConfig, after: JSON.stringify(config) } } });
    return config;
  });
};
