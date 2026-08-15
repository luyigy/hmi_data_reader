import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  buildLiveRoomRosterText,
  encodeLiveRoomRoleLabel,
  ensureLiveRoomUserMember,
  listLiveRoomCatalogAgents,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomSummary,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import {
  permissionConfigForProfile,
  type LiveRoomPermissionProfile,
} from '@/lib/live-room-permissions';
import { authenticationErrorResponse, ownedByCurrentUser, requireCurrentUser, requireExecutionAccess } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    const [rooms, availableAgents] = await Promise.all([
      prisma.liveRoom.findMany({
        where: {
          ...ownedByCurrentUser(user),
          status: {
            in: ['active', 'archived'],
          },
        },
        include: {
          currentSpeaker: {
            include: {
              agentRecord: true,  // Include to get current nickname
            },
          },
          members: {
            include: {
              agentRecord: true,  // Include to get current nickname
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
      }),
      listLiveRoomCatalogAgents(user),
    ]);

    return NextResponse.json({
      rooms: rooms.map(serializeLiveRoomSummary),
      availableAgents,
    });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    console.error('Failed to fetch live rooms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch live rooms' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const currentTopic = typeof body.currentTopic === 'string' ? body.currentTopic.trim() : '';
    const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : '';
    const mode = body.mode === 'execution' || body.mode === 'hybrid' ? body.mode : 'discussion';
    const selectedAgentIds = Array.isArray(body.selectedAgentIds)
      ? body.selectedAgentIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const selectedAgentRoles =
      body.selectedAgentRoles && typeof body.selectedAgentRoles === 'object'
        ? body.selectedAgentRoles as Record<string, unknown>
        : {};
    const selectedAgentPermissions =
      body.selectedAgentPermissions && typeof body.selectedAgentPermissions === 'object'
        ? body.selectedAgentPermissions as Record<string, unknown>
        : {};

    if (!title) {
      return NextResponse.json(
        { error: 'Room title is required' },
        { status: 400 }
      );
    }

    const availableAgents = await listLiveRoomCatalogAgents(user);
    const selectedAgents = availableAgents.filter((agent) => selectedAgentIds.includes(agent.id));
    await requireExecutionAccess(user, selectedAgents.map((agent) => ({
      executionBackend: agent.backend,
      gatewayId: agent.gatewayId,
    })));

    const room = await prisma.liveRoom.create({
      data: {
        title,
        description: description || null,
        currentTopic: currentTopic || null,
        workingDirectory: workingDirectory || null,
        mode,
        status: 'active',
        createdBy: 'user',
        ownerUserId: user.id === 'admin' ? null : user.id,
      },
    });

    const userMember = await ensureLiveRoomUserMember(room.id);

    const createdMembers = await Promise.all(
      selectedAgents.map((agent, index) =>
        prisma.liveRoomMember.create({
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
            role: typeof selectedAgentRoles[agent.id] === 'string'
              ? (selectedAgentRoles[agent.id] as string).trim() || 'custom'
              : 'custom',
            acpxPermissionConfig: JSON.stringify(permissionConfigForProfile(
              (['safe_local', 'dev_local', 'full_access'].includes(String(selectedAgentPermissions[agent.id]))
                ? selectedAgentPermissions[agent.id]
                : 'safe_local') as LiveRoomPermissionProfile
            )),
            roleLabel: encodeLiveRoomRoleLabel({
              backend: agent.backend,
              label: agent.label,
              remoteHostId: agent.backend === 'remote_ssh' ? agent.gatewayId : null,
            }),
            joinStatus: 'joined',
            presenceStatus: agent.status === 'online' ? 'online' : 'idle',
            canReply: true,
            sortOrder: index + 2,
          },
        })
      )
    );

    const currentSpeaker = createdMembers[0] || null;

    if (currentSpeaker) {
      await prisma.liveRoom.update({
        where: { id: room.id },
        data: {
          currentSpeakerMemberId: currentSpeaker.id,
        },
      });
    }

    await syncLiveRoomSourceTask(room.id);

    const rosterMembers = await prisma.liveRoomMember.findMany({
      where: { roomId: room.id },
      include: {
        gateway: true,
      },
      orderBy: {
        sortOrder: 'asc',
      },
    });

    await postLiveRoomMessage({
      roomId: room.id,
      content: currentTopic
        ? `房间已创建。当前 topic：${currentTopic}`
        : '房间已创建。你可以先设定 topic，然后继续邀请 agent 讨论。',
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: {
          createdBy: userMember.id,
          selectedAgentCount: createdMembers.length,
        },
      }),
    });

    await postLiveRoomMessage({
      roomId: room.id,
      content: `当前房间成员：\n${buildLiveRoomRosterText(rosterMembers)}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: {
          systemEvent: 'room_roster',
          memberCount: rosterMembers.length,
        },
      }),
    });

    const hydratedRoom = await prisma.liveRoom.findUnique({
      where: { id: room.id },
      include: {
        currentSpeaker: true,
        members: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return NextResponse.json({
      room: hydratedRoom ? serializeLiveRoomSummary(hydratedRoom) : null,
    }, { status: 201 });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    console.error('Failed to create live room:', error);
    return NextResponse.json(
      { error: 'Failed to create live room' },
      { status: 500 }
    );
  }
}
