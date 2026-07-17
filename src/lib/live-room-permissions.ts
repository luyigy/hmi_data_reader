import { prisma } from './prisma';
import {
  buildAcpxPermissionConfigForProfile,
  DEFAULT_ACPX_PERMISSION_CONFIG,
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

export const setLiveRoomMemberPermission = async (
  roomId: string,
  memberId: string,
  profile: LiveRoomPermissionProfile
) => {
  const member = await prisma.liveRoomMember.findFirst({
    where: { id: memberId, roomId, canReply: true },
    include: {
      room: {
        select: {
          sourceTask: {
            select: { acpxPermissionConfig: true },
          },
        },
      },
    },
  });
  if (!member) throw new Error('Member not found');

  const config = permissionConfigForProfile(
    profile,
    resolveLiveRoomMemberPermission(
      member.acpxPermissionConfig,
      member.room.sourceTask?.acpxPermissionConfig
    ).writableRoots
  );
  await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: { acpxPermissionConfig: JSON.stringify(config) },
  });
  return config;
};
