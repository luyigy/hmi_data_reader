import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { postLiveRoomMessage, syncLiveRoomSourceTask } from '@/lib/live-room';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await requireCurrentUser(request);
    const body = await request.json().catch(() => ({}));
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';

    const room = await prisma.liveRoom.findFirst({
      where: { id: params.id, ...ownedByCurrentUser(user) },
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    await prisma.liveRoom.update({
      where: { id: room.id },
      data: {
        currentTopic: topic || null,
      },
    });

    await syncLiveRoomSourceTask(room.id);

    await postLiveRoomMessage({
      roomId: room.id,
      content: topic ? `Topic 已更新：${topic}` : '当前 topic 已清空。',
      messageType: 'topic',
      metadata: {
        topic: topic || null,
      },
    });

    return NextResponse.json({
      ok: true,
      topic: topic || null,
    });
  } catch (error) {
    console.error('Failed to update live room topic:', error);
    return NextResponse.json(
      { error: 'Failed to update live room topic' },
      { status: 500 }
    );
  }
}
