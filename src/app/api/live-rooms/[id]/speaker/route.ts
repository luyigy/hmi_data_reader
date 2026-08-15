import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { postLiveRoomMessage, resolveLiveRoomMessageMetadata } from '@/lib/live-room';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await requireCurrentUser(request);
    const room = await prisma.liveRoom.findFirst({ where: { id: params.id, ...ownedByCurrentUser(user) } });
    if (!room) return NextResponse.json({ error: 'Live room not found' }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';

    if (!memberId) {
      return NextResponse.json(
        { error: 'memberId is required' },
        { status: 400 }
      );
    }

    const member = await prisma.liveRoomMember.findFirst({
      where: {
        id: memberId,
        roomId: params.id,
      },
    });

    if (!member) {
      return NextResponse.json(
        { error: 'Speaker member not found in this room' },
        { status: 404 }
      );
    }

    await prisma.liveRoom.update({
      where: { id: params.id },
      data: {
        currentSpeakerMemberId: member.id,
      },
    });

    await postLiveRoomMessage({
      roomId: params.id,
      content: `当前主回复 agent 已切换为 ${member.displayName}。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        handoffToMemberId: member.id,
        extras: {
          speakerMemberId: member.id,
        },
      }),
    });

    return NextResponse.json({
      ok: true,
      memberId: member.id,
    });
  } catch (error) {
    console.error('Failed to update live room speaker:', error);
    return NextResponse.json(
      { error: 'Failed to update live room speaker' },
      { status: 500 }
    );
  }
}
