import { NextRequest, NextResponse } from 'next/server';
import { listLiveRoomPendingReplies } from '@/lib/live-room';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-delivery';
import { prisma } from '@/lib/prisma';
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

    const result = await interruptLiveRoomMemberReplies({
      roomId: params.id,
      memberId,
    });

    const pendingReplies = await listLiveRoomPendingReplies(params.id);

    return NextResponse.json({
      ok: true,
      ...result,
      pendingReplyCount: pendingReplies.reduce((total, reply) => total + reply.pendingCount, 0),
      pendingReplyTargetNames: pendingReplies.map((reply) => reply.displayName),
      pendingReplies,
    });
  } catch (error) {
    console.error('Failed to interrupt live room member replies:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to interrupt live room member replies' },
      { status: 500 }
    );
  }
}
