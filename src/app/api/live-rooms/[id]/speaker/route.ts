import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { postLiveRoomMessage } from '@/lib/live-room';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
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
      metadata: {
        speakerMemberId: member.id,
      },
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
