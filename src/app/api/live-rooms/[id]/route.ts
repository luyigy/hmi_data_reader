import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  emitLiveRoomDeleted,
  emitLiveRoomUpdated,
  listLiveRoomCatalogAgents,
  listLiveRoomPendingReplies,
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
    const pendingReplies = await listLiveRoomPendingReplies(params.id);

    return NextResponse.json({
      room: {
        ...serializeLiveRoomSummary(room),
        sourceTask: room.sourceTask,
        pendingReplyCount: pendingReplies.reduce((total, reply) => total + reply.pendingCount, 0),
        pendingReplyTargetNames: pendingReplies.map((reply) => reply.displayName),
        pendingReplies,
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const existing = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        title: true,
        description: true,
        currentTopic: true,
        mode: true,
        status: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : existing.title;

    if (!title) {
      return NextResponse.json(
        { error: 'Room title is required' },
        { status: 400 }
      );
    }

    const updated = await prisma.liveRoom.update({
      where: { id: params.id },
      data: {
        title,
        description:
          typeof body.description === 'string'
            ? (body.description.trim() || null)
            : existing.description,
        currentTopic:
          typeof body.currentTopic === 'string'
            ? (body.currentTopic.trim() || null)
            : existing.currentTopic,
        mode:
          body.mode === 'discussion' || body.mode === 'execution' || body.mode === 'hybrid'
            ? body.mode
            : existing.mode,
        status:
          body.status === 'active' || body.status === 'archived'
            ? body.status
            : existing.status,
      },
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

    await emitLiveRoomUpdated(updated.id);

    const pendingReplies = await listLiveRoomPendingReplies(params.id);

    return NextResponse.json({
      room: {
        ...serializeLiveRoomSummary(updated),
        sourceTask: updated.sourceTask,
        pendingReplyCount: pendingReplies.reduce((total, reply) => total + reply.pendingCount, 0),
        pendingReplyTargetNames: pendingReplies.map((reply) => reply.displayName),
        pendingReplies,
        members: updated.members.map(serializeLiveRoomMember),
      },
    });
  } catch (error) {
    console.error('Failed to update live room:', error);
    return NextResponse.json(
      { error: 'Failed to update live room' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const hardDelete = request.nextUrl.searchParams.get('hard') === 'true';
    const existing = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        title: true,
        status: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    if (!hardDelete) {
      await prisma.liveRoom.update({
        where: { id: params.id },
        data: {
          status: 'archived',
        },
      });

      await emitLiveRoomUpdated(existing.id);

      return NextResponse.json({
        success: true,
        archived: true,
        id: existing.id,
        title: existing.title,
      });
    }

    if (existing.status !== 'archived') {
      return NextResponse.json(
        { error: 'Live room must be archived before permanent deletion' },
        { status: 400 }
      );
    }

    await prisma.liveRoom.delete({
      where: { id: params.id },
    });

    emitLiveRoomDeleted(existing.id);

    return NextResponse.json({
      success: true,
      deleted: true,
      id: existing.id,
      title: existing.title,
    });
  } catch (error) {
    console.error('Failed to delete live room:', error);
    return NextResponse.json(
      { error: 'Failed to delete live room' },
      { status: 500 }
    );
  }
}
