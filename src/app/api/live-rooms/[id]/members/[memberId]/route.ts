import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';
import { postLiveRoomMessage, resolveLiveRoomMessageMetadata, syncLiveRoomSourceTask } from '@/lib/live-room';

/**
 * DELETE /api/live-rooms/[id]/members/[memberId]
 * 从 Live Room 移除成员
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; memberId: string } }
) {
  try {
    const member = await prisma.liveRoomMember.findUnique({
      where: { id: params.memberId },
    });

    if (!member || member.roomId !== params.id) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    if (member.memberType === 'user') {
      return NextResponse.json({ error: 'Cannot remove the user member' }, { status: 400 });
    }

    await prisma.liveRoomMember.delete({ where: { id: params.memberId } });

    // If this was the current speaker, clear it
    const room = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: { currentSpeakerMemberId: true },
    });
    if (room?.currentSpeakerMemberId === params.memberId) {
      const next = await prisma.liveRoomMember.findFirst({
        where: { roomId: params.id, canReply: true },
        orderBy: { sortOrder: 'asc' },
      });
      await prisma.liveRoom.update({
        where: { id: params.id },
        data: { currentSpeakerMemberId: next?.id ?? null },
      });
    }

    await postLiveRoomMessage({
      roomId: params.id,
      content: `${member.displayName} 已从房间移除。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: { systemEvent: 'member_removed', memberId: params.memberId },
      }),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to remove live room member:', error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}

/**
 * PATCH /api/live-rooms/[id]/members/[memberId]
 * 更新 Live Room 成员的房间专属昵称
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string; memberId: string } }
) {
  try {
    const body = await request.json();
    const { userNickname, shortAlias } = body;
    const role = typeof body.role === 'string' ? body.role.trim() || 'custom' : undefined;

    // 验证成员存在
    const member = await prisma.liveRoomMember.findUnique({
      where: { id: params.memberId },
      include: {
        agentRecord: {
          include: { gateway: true },
        },
        gateway: true,
      },
    });

    if (!member) {
      return NextResponse.json(
        { error: 'Member not found' },
        { status: 404 }
      );
    }
    if (member.roomId !== params.id) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // 如果设置了昵称但未提供 shortAlias，自动生成
    let generatedShortAlias = shortAlias;
    if (userNickname && !shortAlias) {
      generatedShortAlias = generateShortAlias(
        userNickname,
        member.harnessType || 'unknown',
        member.gateway?.name || null,
        member.backend
      );
    }

    // 更新成员
    const updated = await prisma.liveRoomMember.update({
      where: { id: params.memberId },
      data: {
        userNickname: userNickname ?? undefined,
        shortAlias: generatedShortAlias ?? undefined,
        role,
      },
    });
    await syncLiveRoomSourceTask(params.id);

    return NextResponse.json({
      success: true,
      member: {
        id: updated.id,
        displayName: updated.displayName,
        userNickname: updated.userNickname,
        shortAlias: updated.shortAlias,
        role: updated.role,
      },
    });
  } catch (error) {
    console.error('Failed to update member:', error);
    return NextResponse.json(
      { error: 'Failed to update member' },
      { status: 500 }
    );
  }
}
