import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  detectMentionedLiveRoomMembers,
  ensureLiveRoomUserMember,
  mergeLiveRoomMentionedMemberIds,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomMessage,
} from '@/lib/live-room';
import { triggerLiveRoomAgentReply } from '@/lib/live-room-delivery';

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
    const detectedMentionedMemberIds = detectMentionedLiveRoomMembers({
      content,
      members: roomMembers,
      senderMemberId: userMember.id,
    });
    const mentionedMemberIds = mergeLiveRoomMentionedMemberIds({
      explicitMentionMemberIds,
      detectedMentionedMemberIds,
      members: roomMembers,
      senderMemberId: userMember.id,
    });
    // If the message carries a structured mention, route by mention first.
    const resolvedTargetMemberId = mentionedMemberIds[0] || targetMemberId || '';
    const message = await postLiveRoomMessage({
      roomId: params.id,
      senderMemberId: userMember.id,
      content,
      messageType: 'user',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'user',
        targetMemberId: resolvedTargetMemberId || null,
        mentionedMemberIds,
      }),
    });

    if (autoReply) {
      await triggerLiveRoomAgentReply({
        roomId: params.id,
        roomMessageId: message.id,
        targetMemberId: resolvedTargetMemberId || null,
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

    return NextResponse.json({
      message,
      messages: freshMessages.map(serializeLiveRoomMessage),
    }, { status: 201 });
  } catch (error) {
    console.error('Failed to post live room message:', error);
    return NextResponse.json(
      { error: 'Failed to post live room message' },
      { status: 500 }
    );
  }
}
