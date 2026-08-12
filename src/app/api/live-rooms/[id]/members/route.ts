import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  buildLiveRoomRosterText,
  encodeLiveRoomRoleLabel,
  extractRemoteHostIdFromRoleLabel,
  listLiveRoomCatalogAgents,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomMemberWithContext,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import {
  permissionConfigForProfile,
  type LiveRoomPermissionProfile,
} from '@/lib/live-room-permissions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json().catch(() => ({}));
    const selectedAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const role = typeof body.role === 'string' ? body.role.trim() || 'custom' : 'custom';
    const permissionProfile = (['safe_local', 'dev_local', 'full_access'].includes(body.permissionProfile)
      ? body.permissionProfile
      : 'safe_local') as LiveRoomPermissionProfile;

    if (!selectedAgentId) {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 }
      );
    }

    const room = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      include: {
        members: true,
      },
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    const availableAgents = await listLiveRoomCatalogAgents();
    const agent = availableAgents.find((item) => item.id === selectedAgentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'Selected agent is not available' },
        { status: 400 }
      );
    }

    const duplicate = room.members.find((member) =>
      member.runtimeAgentId === (agent.runtimeAgentId || null)
      && member.backend === agent.backend
      && (
        agent.backend === 'remote_ssh'
          ? extractRemoteHostIdFromRoleLabel(member.roleLabel) === agent.gatewayId
          : member.gatewayId === (agent.gatewayId === 'platform-local' ? null : agent.gatewayId)
      )
    );

    if (duplicate) {
      const sourceTask = room.sourceTaskId
        ? await prisma.task.findUnique({
            where: { id: room.sourceTaskId },
            select: {
              id: true,
              name: true,
              acpxPermissionConfig: true,
            },
          })
        : null;

      return NextResponse.json({
        member: await serializeLiveRoomMemberWithContext({
          member: {
            ...duplicate,
            gateway: null,
          },
          sourceTask,
        }),
        duplicate: true,
      });
    }

    const maxSort = room.members.reduce((max, member) => Math.max(max, member.sortOrder), 0);
    const created = await prisma.liveRoomMember.create({
      data: {
        roomId: room.id,
        agentRecordId: agent.agentRecordId || null,
        gatewayId:
          agent.backend === 'gateway_openclaw'
            ? (agent.gatewayId === 'platform-local' ? null : agent.gatewayId)
            : null,
        memberType:
          agent.backend === 'gateway_openclaw'
            ? 'gateway_agent'
            : agent.backend === 'remote_ssh'
            ? 'remote_agent'
            : 'local_agent',
        displayName: agent.userNickname || agent.agentName || agent.label,
        agentNameSnapshot: agent.userNickname || agent.agentName || agent.label,
        harnessType: agent.harnessType,
        backend: agent.backend,
        runtimeAgentId: agent.runtimeAgentId || null,
        role,
        acpxPermissionConfig: JSON.stringify(permissionConfigForProfile(permissionProfile)),
        roleLabel: encodeLiveRoomRoleLabel({
          backend: agent.backend,
          label: agent.label,
          remoteHostId: agent.backend === 'remote_ssh' ? agent.gatewayId : null,
        }),
        joinStatus: 'joined',
        presenceStatus: agent.status === 'online' ? 'online' : agent.status === 'offline' ? 'offline' : 'idle',
        canReply: true,
        sortOrder: maxSort + 1,
      },
      include: {
        gateway: true,
        agentRecord: true,  // Include to get current nickname
      },
    });

    if (!room.currentSpeakerMemberId) {
      await prisma.liveRoom.update({
        where: { id: room.id },
        data: {
          currentSpeakerMemberId: created.id,
        },
      });
    }

    const sourceTask = await syncLiveRoomSourceTask(room.id);

    const rosterMembers = await prisma.liveRoomMember.findMany({
      where: { roomId: room.id },
      include: {
        gateway: true,
        agentRecord: true,  // Include to get current nickname
      },
      orderBy: {
        sortOrder: 'asc',
      },
    });

    await postLiveRoomMessage({
      roomId: room.id,
      content: `${created.displayName} 已加入房间。\n\n当前房间成员：\n${buildLiveRoomRosterText(rosterMembers)}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: {
          systemEvent: 'member_joined',
          memberId: created.id,
        },
      }),
    });

    return NextResponse.json({
      member: await serializeLiveRoomMemberWithContext({
        member: created,
        sourceTask,
      }),
      duplicate: false,
    }, { status: 201 });
  } catch (error) {
    console.error('Failed to add live room member:', error);
    return NextResponse.json(
      { error: 'Failed to add live room member' },
      { status: 500 }
    );
  }
}
