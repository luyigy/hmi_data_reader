import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  ensureLiveRoomUserMember,
  listLiveRoomCatalogAgents,
  postLiveRoomMessage,
  serializeLiveRoomSummary,
} from '@/lib/live-room';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [rooms, availableAgents] = await Promise.all([
      prisma.liveRoom.findMany({
        where: {
          status: 'active',
        },
        include: {
          currentSpeaker: true,
          members: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
      }),
      listLiveRoomCatalogAgents(),
    ]);

    return NextResponse.json({
      rooms: rooms.map(serializeLiveRoomSummary),
      availableAgents,
    });
  } catch (error) {
    console.error('Failed to fetch live rooms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch live rooms' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const currentTopic = typeof body.currentTopic === 'string' ? body.currentTopic.trim() : '';
    const mode = body.mode === 'execution' || body.mode === 'hybrid' ? body.mode : 'discussion';
    const selectedAgentIds = Array.isArray(body.selectedAgentIds)
      ? body.selectedAgentIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    if (!title) {
      return NextResponse.json(
        { error: 'Room title is required' },
        { status: 400 }
      );
    }

    const availableAgents = await listLiveRoomCatalogAgents();
    const selectedAgents = availableAgents.filter((agent) => selectedAgentIds.includes(agent.id));

    const room = await prisma.liveRoom.create({
      data: {
        title,
        description: description || null,
        currentTopic: currentTopic || null,
        mode,
        status: 'active',
        createdBy: 'user',
      },
    });

    const userMember = await ensureLiveRoomUserMember(room.id);

    const createdMembers = await Promise.all(
      selectedAgents.map((agent, index) =>
        prisma.liveRoomMember.create({
          data: {
            roomId: room.id,
            agentRecordId: agent.agentRecordId || null,
            gatewayId: agent.gatewayId === 'platform-local' ? null : agent.gatewayId,
            memberType: agent.backend === 'gateway_openclaw' ? 'gateway_agent' : 'local_agent',
            displayName: agent.agentName || agent.label,
            agentNameSnapshot: agent.agentName || agent.label,
            harnessType: agent.harnessType,
            backend: agent.backend,
            runtimeAgentId: agent.runtimeAgentId || null,
            roleLabel: agent.label,
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

    await postLiveRoomMessage({
      roomId: room.id,
      content: currentTopic
        ? `房间已创建。当前 topic：${currentTopic}`
        : '房间已创建。你可以先设定 topic，然后继续邀请 agent 讨论。',
      messageType: 'system',
      metadata: {
        createdBy: userMember.id,
        selectedAgentCount: createdMembers.length,
      },
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
    console.error('Failed to create live room:', error);
    return NextResponse.json(
      { error: 'Failed to create live room' },
      { status: 500 }
    );
  }
}
