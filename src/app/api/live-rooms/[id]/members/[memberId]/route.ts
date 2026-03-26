import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';

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
      },
    });

    return NextResponse.json({
      success: true,
      member: {
        id: updated.id,
        displayName: updated.displayName,
        userNickname: updated.userNickname,
        shortAlias: updated.shortAlias,
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
