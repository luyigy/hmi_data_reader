import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  listLiveRoomCatalogAgents,
  serializeLiveRoomMember,
  serializeLiveRoomSummary,
} from '@/lib/live-room';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const room = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      include: {
        currentSpeaker: true,
        sourceTask: {
          select: {
            id: true,
            name: true,
          },
        },
        members: {
          include: {
            gateway: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    const availableAgents = await listLiveRoomCatalogAgents();

    return NextResponse.json({
      room: {
        ...serializeLiveRoomSummary(room),
        sourceTask: room.sourceTask,
        members: room.members.map(serializeLiveRoomMember),
      },
      availableAgents,
    });
  } catch (error) {
    console.error('Failed to fetch live room:', error);
    return NextResponse.json(
      { error: 'Failed to fetch live room' },
      { status: 500 }
    );
  }
}
