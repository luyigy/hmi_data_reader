import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  ensureLiveRoomUserMember,
  listLiveRoomPendingReplies,
  mergeLiveRoomMentionedMemberIds,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomMessage,
} from '@/lib/live-room';
import { triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const limitParam = Number(request.nextUrl.searchParams.get('limit') || '80');
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 80;

    const messages = await prisma.liveRoomMessage.findMany({
      where: { roomId: params.id },
      include: {
        senderMember: {
          include: {
            gateway: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: limit,
    });

    return NextResponse.json({
      messages: messages.map(serializeLiveRoomMessage),
    });
  } catch (error) {
    console.error('Failed to fetch live room messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch live room messages' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json().catch(() => ({}));
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const targetMemberId = typeof body.targetMemberId === 'string' ? body.targetMemberId.trim() : '';
    const explicitMentionMemberIds = Array.isArray(body.explicitMentionMemberIds)
      ? body.explicitMentionMemberIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const explicitMentionAll = body.explicitMentionAll === true;
    const autoReply = body.autoReply !== false;

    if (!content) {
      return NextResponse.json(
        { error: 'Message content is required' },
        { status: 400 }
      );
    }

    const room = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Live room not found' },
        { status: 404 }
      );
    }

    const userMember = await ensureLiveRoomUserMember(params.id);
    const roomMembers = await prisma.liveRoomMember.findMany({
      where: { roomId: params.id },
      include: {
        gateway: true,
      },
    });
    const mentionedAll = explicitMentionAll || detectLiveRoomMentionAll(content);
    const expectedResponderMemberIds = mentionedAll
      ? roomMembers.filter((member) => member.canReply && member.id !== userMember.id).map((member) => member.id)
      : [];
    const detectedMentionedMemberIds = detectMentionedLiveRoomMembers({
      content,
      members: roomMembers,
      senderMemberId: userMember.id,
    });
    const mentionedMemberIds = mergeLiveRoomMentionedMemberIds({
      explicitMentionMemberIds,
      detectedMentionedMemberIds: mentionedAll ? expectedResponderMemberIds : detectedMentionedMemberIds,
      members: roomMembers,
      senderMemberId: userMember.id,
    });
    // If the message carries a structured mention, route by mention first.
    const resolvedTargetMemberId = mentionedAll ? '' : (mentionedMemberIds[0] || targetMemberId || '');
    const message = await postLiveRoomMessage({
      roomId: params.id,
      senderMemberId: userMember.id,
      content,
      messageType: 'user',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'user',
        targetMemberId: resolvedTargetMemberId || null,
        mentionedMemberIds,
        mentionedAll,
        expectedResponderMemberIds,
      }),
    });

    if (autoReply) {
      void triggerLiveRoomMessageReplies({
        roomId: params.id,
        roomMessageId: message.id,
        requestedTargetMemberId: resolvedTargetMemberId || null,
      }).catch((error) => {
        console.error('Failed to trigger live room auto reply:', error);
      });
    }

    const freshMessages = await prisma.liveRoomMessage.findMany({
      where: { roomId: params.id },
      include: {
        senderMember: {
          include: {
            gateway: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: 120,
    });

    const pendingReplies = await listLiveRoomPendingReplies(params.id);

    return NextResponse.json({
      message,
      messages: freshMessages.map(serializeLiveRoomMessage),
      pendingReplyCount: pendingReplies.reduce((total, reply) => total + reply.pendingCount, 0),
      pendingReplyTargetNames: pendingReplies.map((reply) => reply.displayName),
      pendingReplies,
    }, { status: 201 });
  } catch (error) {
    console.error('Failed to post live room message:', error);
    return NextResponse.json(
      { error: 'Failed to post live room message' },
      { status: 500 }
    );
  }
}
